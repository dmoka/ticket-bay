// Invariant properties for the invoice export (legacy-testing, step 5), over
// a real Postgres: a generated set of events and orders, one export, the
// rules checked against a model written here — not the production code.
//
// The properties, in English:
//  1. Membership. For any orders — any venue (a mapped organizer or not), any
//     status, any instant around the month, any event — the export of a month
//     holds exactly the paid orders created from the first instant of the
//     month up to (not including) the first instant of the next, each once;
//     with an event filter, only that event's. Every line of one venue sits in
//     one organizer block, and a block's lines are in order-id order.
//  2. Money. On every line net + VAT = gross = the order's tickets amount, and
//     VAT = gross × 27 / 127 rounded half up (so 0 ≤ VAT ≤ gross). A block
//     sums its lines; the totals sum the blocks; totals.invoices counts the
//     lines. The discount percentage is a whole number from 0 to 100.
//  3. Numbers. The invoice numbers are TB-YYYYMM- and six digits, consecutive
//     from where the running number stood, each used once.
//  4. The CSV. A header and one line per invoice; parsed back by the RFC 4180
//     rules every field equals the line's — organizer, tax number, customer
//     and event names with commas, quotes, line breaks and any script in them.
//  5. The mails. One per organizer block, to the block's address, counted.
//
// The seed is fixed so a failure replays exactly; FC_SEED=<n> explores another
// stream.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { sql } from "drizzle-orm";
import { createEvent } from "../../src/db/events-repo";
import { events, orders } from "../../src/db/schema";
import { invoiceExport } from "../../src/finance/invoices";
import { useTestDatabase } from "./database";
import { DAY, NOW } from "./fixtures";

const t = useTestDatabase();

const SEED = Number(process.env.FC_SEED ?? 20261008);
const runs = (numRuns: number) => ({ seed: SEED, numRuns });

const JAN = Date.UTC(2027, 0, 1);
const FEB = Date.UTC(2027, 1, 1);

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "invoices-property-"));
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** n / d rounded half up, in integers. */
const roundHalfUp = (n: number, d: number) => Math.floor((2 * n + d) / (2 * d));

// ---- Generators ---------------------------------------------------------------------

/** Text as people and keyboards make it: ASCII with the CSV specials, any script, control characters — never NUL (Postgres text refuses it). */
const text = fc
  .oneof(
    { withCrossShrink: true },
    { weight: 3, arbitrary: fc.string({ unit: fc.constantFrom("a", "b", " ", ",", '"', "\n", "\r", "\t", "é", "…", ";", "'"), maxLength: 40 }) },
    { weight: 2, arbitrary: fc.string({ unit: "grapheme", maxLength: 40 }) },
    { weight: 1, arbitrary: fc.string({ unit: fc.integer({ min: 1, max: 0x1f }).map((c) => String.fromCharCode(c)), maxLength: 5 }) },
    { weight: 1, arbitrary: fc.string({ unit: "grapheme-ascii", minLength: 25, maxLength: 120 }) },
  )
  .map((s) => s.replaceAll("\u0000", ""));

const MAPPED_VENUES = ["Budapest Park", "Zamárdi Beach", "Hungexpo Hall G", "MVM Dome", "Kisüzem", "A38 Ship", "Opus Jazz Club"];
const venueName = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...MAPPED_VENUES) },
  fc.constantFrom("Arena", "Dumaszínház", "Foo, Bar", 'Q "Quoted" Hall', "Zamárdi Beach "),
  text.filter((s) => s.length > 0),
);

/** An instant: mostly inside the month, often exactly on its edges, sometimes far away. */
const instant = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: JAN, max: FEB - 1 }) },
  { weight: 2, arbitrary: fc.constantFrom(JAN - 1, JAN, FEB - 1, FEB) },
  { weight: 1, arbitrary: fc.integer({ min: JAN - 400 * DAY, max: FEB + 400 * DAY }) },
);

/**
 * A tickets amount in cents, from 3 cents to €10 million. Zero (a free order)
 * and 1 or 2 cents (a VAT of 0 cents) are left out until the pinned crashes
 * are fixed — invoices.test.ts "suspected bug: a free order (0 cents of
 * tickets) throws RangeError" and "suspected bug: an order of 1 or 2 cents
 * (its VAT rounds to 0) throws RangeError"; the second one this property found.
 */
const amount = fc.oneof({ weight: 3, arbitrary: fc.integer({ min: 3, max: 1_000_000 }) }, fc.integer({ min: 3, max: 1_000_000_000 }), fc.constantFrom(3, 50, 99, 100, 127, 254, 12_700));

interface GenEvent {
  venue: string;
  name: string;
}
interface GenOrder {
  event: number;
  customer: string;
  email: string;
  status: "paid" | "refunded";
  createdAtMs: number;
  quantity: number;
  ticketsCents: number;
  discountCents: number;
}
interface GenWorld {
  events: GenEvent[];
  orders: GenOrder[];
  /** index of the event to filter on, or none */
  filter: number | undefined;
  /** where the running number stands */
  seqStart: number;
}

const genOrder = (eventCount: number): fc.Arbitrary<GenOrder> =>
  fc.record({
    event: fc.integer({ min: 0, max: eventCount - 1 }),
    customer: text,
    email: fc.constantFrom("fan@example.com", "ádám@example.com", 'odd,"@example.com'),
    status: fc.constantFrom<"paid" | "refunded">("paid", "paid", "paid", "refunded"),
    createdAtMs: instant,
    quantity: fc.integer({ min: 1, max: 50 }),
    ticketsCents: amount,
    discountCents: fc.oneof({ weight: 2, arbitrary: fc.constant(0) }, fc.integer({ min: 0, max: 1_000_000 })),
  });

const genWorld: fc.Arbitrary<GenWorld> = fc
  .array(fc.record({ venue: venueName, name: text }), { minLength: 1, maxLength: 4 })
  .chain((evs) =>
    fc.record({
      events: fc.constant(evs),
      orders: fc.array(genOrder(evs.length), { minLength: 1, maxLength: 12 }),
      filter: fc.option(fc.integer({ min: 0, max: evs.length - 1 }), { nil: undefined }),
      seqStart: fc.oneof({ weight: 3, arbitrary: fc.constant(1) }, fc.integer({ min: 1, max: 999_999 }), fc.constant(1_000_000)),
    }),
  )
  // Until "a month with no paid orders throws" (invoices.test.ts) is fixed, every world has an invoice in it.
  .filter((w) => expectedOrders(w).length > 0)
  .map((w) => Object.assign(w, { [fc.toStringMethod]: () => JSON.stringify(w) }));

/** The model: the orders the export must list, as indexes into w.orders. */
function expectedOrders(w: GenWorld): number[] {
  return w.orders
    .map((o, i) => i)
    .filter((i) => {
      const o = w.orders[i]!;
      return o.status === "paid" && o.createdAtMs >= JAN && o.createdAtMs < FEB && (w.filter === undefined || o.event === w.filter);
    });
}

// ---- Running a world ----------------------------------------------------------------

const eventId = (i: number) => `ev-${i}`;

async function build(w: GenWorld): Promise<Map<number, number>> {
  await t.db.execute(sql`TRUNCATE ${orders}, ${events} RESTART IDENTITY`);
  for (const [i, e] of w.events.entries()) {
    await createEvent(t.db, { id: eventId(i), name: e.name, category: "concert", venue: e.venue, city: "Budapest", startsAtMs: NOW + 10 * DAY, totalSeats: 1000, seatsSold: 0, priceCents: 5_000, createdAtMs: NOW - 30 * DAY });
  }
  const ids = new Map<number, number>();
  for (const [i, o] of w.orders.entries()) {
    const subtotalCents = o.ticketsCents + o.discountCents;
    const [row] = await t.db
      .insert(orders)
      .values({
        eventId: eventId(o.event),
        customerEmail: o.email,
        customerName: o.customer,
        quantity: o.quantity,
        subtotalCents,
        discountPercent: Math.round((o.discountCents / subtotalCents) * 100),
        discountCents: o.discountCents,
        ticketsCents: o.ticketsCents,
        feeCents: 100,
        totalCents: o.ticketsCents + 100,
        vatCents: 0,
        status: o.status,
        refundedAtMs: o.status === "refunded" ? o.createdAtMs + 1 : null,
        refundCents: o.status === "refunded" ? o.ticketsCents : null,
        refundFeeCents: o.status === "refunded" ? 0 : null,
        refundReason: o.status === "refunded" ? "customer" : null,
        paymentId: `ch_${i}`,
        idempotencyKey: `prop-${i}`,
        createdAtMs: o.createdAtMs,
      })
      .returning({ id: orders.id });
    ids.set(i, row!.id);
  }
  return ids;
}

/** RFC 4180: fields split on commas, quoted fields may hold commas, quotes ("" for one) and line breaks. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const eur = (cents: number) => (cents / 100).toFixed(2);

interface Line {
  invoiceNo: string;
  orderId: number;
  orderNumber: string;
  date: string;
  customer: string;
  customerEmail: string;
  eventId: string;
  eventName: string;
  tickets: number;
  discountPercent: number;
  netCents: number;
  vatCents: number;
  grossCents: number;
}
interface Block {
  organizer: string;
  email: string;
  taxNo: string;
  lines: Line[];
  netCents: number;
  vatCents: number;
  grossCents: number;
}

describe("invoice export invariants", () => {
  it("membership, money, numbers, the CSV and the mails hold for any orders of a month", async () => {
    await fc.assert(
      fc.asyncProperty(genWorld, async (w) => {
        const ids = await build(w);
        const runDir = fs.mkdtempSync(path.join(dir, "run-"));
        let next = w.seqStart;
        const r = await invoiceExport({ month: "2027-01", event: w.filter === undefined ? null : eventId(w.filter) }, { db: t.db, nowMs: NOW, dir: runDir, sequence: { next: () => next++ } });
        const blocks: Block[] = r.organizers;
        const lines = blocks.flatMap((b) => b.lines);

        // 1. membership: exactly the paid orders of the window (of the event), each once
        const expected = expectedOrders(w).map((i) => ids.get(i)!);
        expect([...lines.map((l) => l.orderId)].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
        // ...every line of a venue in one block, blocks distinct, lines of a block by id
        const byId = new Map(w.orders.map((o, i) => [ids.get(i)!, o]));
        const blockOfVenue = new Map<string, string>();
        for (const b of blocks) {
          expect(b.lines.length).toBeGreaterThan(0);
          for (const l of b.lines) {
            const v = w.events[byId.get(l.orderId)!.event]!.venue;
            if (blockOfVenue.has(v)) expect(blockOfVenue.get(v)).toBe(b.organizer);
            blockOfVenue.set(v, b.organizer);
            if (!MAPPED_VENUES.includes(v)) expect(b).toMatchObject({ organizer: v, email: "invoices@ticketbay.example", taxNo: "" });
            else expect(b.organizer).not.toBe(v);
          }
          expect(b.lines.map((l) => l.orderId)).toEqual([...b.lines.map((l) => l.orderId)].sort((a, b) => a - b));
        }
        expect(new Set(blocks.map((b) => b.organizer)).size).toBe(blocks.length);

        // 2. money
        for (const l of lines) {
          const o = byId.get(l.orderId)!;
          expect(l.grossCents).toBe(o.ticketsCents);
          expect(l.vatCents).toBe(roundHalfUp(o.ticketsCents * 27, 127));
          expect(l.netCents + l.vatCents).toBe(l.grossCents);
          expect(l.vatCents).toBeGreaterThanOrEqual(0);
          expect(l.vatCents).toBeLessThanOrEqual(l.grossCents);
          expect(Number.isInteger(l.discountPercent) && l.discountPercent >= 0 && l.discountPercent <= 100, `discount ${l.discountPercent}`).toBe(true);
          expect(l).toMatchObject({ customer: o.customer, customerEmail: o.email, tickets: o.quantity, eventId: eventId(o.event), eventName: w.events[o.event]!.name, date: new Date(o.createdAtMs).toISOString().slice(0, 10), orderNumber: `TB-${String(l.orderId).padStart(5, "0")}` });
        }
        const sum = (xs: { netCents: number; vatCents: number; grossCents: number }[]) => ({
          netCents: xs.reduce((a, x) => a + x.netCents, 0),
          vatCents: xs.reduce((a, x) => a + x.vatCents, 0),
          grossCents: xs.reduce((a, x) => a + x.grossCents, 0),
        });
        for (const b of blocks) expect({ netCents: b.netCents, vatCents: b.vatCents, grossCents: b.grossCents }).toEqual(sum(b.lines));
        expect(r.totals).toEqual({ invoices: lines.length, ...sum(blocks) });

        // 3. numbers
        expect(lines.map((l) => l.invoiceNo)).toEqual(lines.map((_, k) => `TB-202701-${String(w.seqStart + k).padStart(6, "0")}`));
        expect(r.batchId).toBe(`INV-2027-01-${lines[0]!.orderId}`);
        expect(r.month).toBe("2027-01");

        // 4. the CSV
        const rows = parseCsv(fs.readFileSync(path.join(runDir, "invoices-2027-01.csv"), "utf8"));
        expect(rows[0]).toEqual(["batch_id", "invoice_no", "order_no", "date", "organizer", "organizer_tax_no", "customer", "event", "tickets", "discount_pct", "net_eur", "vat_eur", "gross_eur", "vat_rate"]);
        expect(rows.length).toBe(lines.length + 1);
        let k = 1;
        for (const b of blocks) {
          for (const l of b.lines) {
            expect(rows[k++]).toEqual([r.batchId, l.invoiceNo, l.orderNumber, l.date, b.organizer, b.taxNo, l.customer, l.eventName, String(l.tickets), String(l.discountPercent), eur(l.netCents), eur(l.vatCents), eur(l.grossCents), "27%"]);
          }
        }

        // 5. the mails
        expect(r.emailsSent).toBe(blocks.length);
        const mails = fs.readFileSync(path.join(runDir, "outbox.log"), "utf8").split("\n-----\n").filter((m) => m !== "");
        expect(mails.length).toBe(blocks.length);
        for (const [j, b] of blocks.entries()) {
          expect(mails[j]!.startsWith(`To: ${b.email}\nSubject: TicketBay invoices 2027-01 (${r.batchId})\n`)).toBe(true);
          expect(mails[j]).toContain(`\n  invoices:  ${b.lines.length}\n`);
          expect(mails[j]).toContain(`First invoice: ${b.lines[0]!.invoiceNo}, last invoice: ${b.lines[b.lines.length - 1]!.invoiceNo}\n`);
        }
        expect(r.files.map((f: string) => path.basename(f))).toEqual(["invoices-2027-01.csv", "invoices-2027-01.txt"]);
      }),
      runs(Number(process.env.PROPERTY_RUNS ?? 150)),
    );
  }, 180_000);
});
