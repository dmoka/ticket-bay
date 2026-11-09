// GET /api/v1/organizer/invoices end to end: real Requests into the route
// handler, real Better Auth API keys, real Postgres (Testcontainers). Pins what
// the endpoint does today — which orders it invoices, who may read it, what it
// writes — suspected bugs included ("pins current behaviour — suspected bug: …").
//
// The export writes reports/invoices-<month>.csv/.txt and appends to
// reports/outbox.log (gitignored), and its running invoice number lives in
// the module for the whole file, so the tests compare numbers, not absolutes.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import type { Auth } from "../../src/auth/auth";
import { orders } from "../../src/db/schema";
import { createFakeStripe } from "../../src/payments";
import { customer, makeAuth, scopedKey, useCleanAccounts } from "../integration/accounts";
import { useTestDatabase } from "../integration/database";
import { NOW, venue } from "../integration/fixtures";
import { bearer, call, loadRoutes, quietRefusedKeyLogs } from "./client";

const wiring = vi.hoisted(() => ({ auth: undefined as unknown, db: undefined as unknown, payments: undefined as unknown }));
vi.mock("@/lib/auth", () => ({ appBaseURL: () => "http://localhost:3000", getAuth: () => wiring.auth }));
vi.mock("@/src/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/db/client")>()),
  getDb: () => wiring.db,
}));
vi.mock("@/src/payments", async () => ({ ...(await import("../../src/payments")), getPayments: () => wiring.payments }));

const t = useTestDatabase();
useCleanAccounts(t);
quietRefusedKeyLogs();

let auth: Auth;

beforeAll(async () => {
  process.env.TICKETBAY_TEST_CLOCK = "1";
  auth = makeAuth(t.db);
  wiring.auth = auth;
  wiring.db = t.db;
  wiring.payments = createFakeStripe("sk_test_integration");
  vi.spyOn(console, "log").mockImplementation(() => {});
  await loadRoutes();
});

afterAll(() => {
  delete process.env.TICKETBAY_TEST_CLOCK;
  vi.restoreAllMocks();
});

const OCT = Date.UTC(2026, 9, 1);
const NOV = Date.UTC(2026, 10, 1);

let n = 0;
async function paidOrder(eventId: string, over: Partial<typeof orders.$inferInsert> = {}) {
  const [o] = await t.db
    .insert(orders)
    .values({
      eventId,
      customerEmail: "fan@example.com",
      customerName: "A Fan",
      quantity: 2,
      subtotalCents: 13000,
      discountPercent: 10,
      discountCents: 1300,
      ticketsCents: 11700,
      feeCents: 351,
      totalCents: 12051,
      vatCents: 2562,
      paymentId: `ch_${++n}`,
      idempotencyKey: `inv-${n}`,
      createdAtMs: OCT + 2 * 86_400_000,
      ...over,
    })
    .returning();
  return o!;
}

async function keyHolder(scope: "read" | "read-write" = "read-write") {
  const c = await customer(auth);
  if (scope === "read-write") return c.key;
  return (await scopedKey(auth, c.id, "read")).key;
}

const invoices = async (query: string, key?: string) =>
  call({ path: "/api/v1/organizer/invoices" + query, headers: key ? bearer(key) : {}, nowMs: NOW });

const lineIds = (body: { organizers: { lines: { orderId: number }[] }[] }) => body.organizers.flatMap((g) => g.lines.map((l) => l.orderId));
const numbers = (body: { organizers: { lines: { invoiceNo: string }[] }[] }) => body.organizers.flatMap((g) => g.lines.map((l) => l.invoiceNo));
const seqOf = (invoiceNo: string) => Number(invoiceNo.split("-")[2]);

describe("GET /api/v1/organizer/invoices — who may call it", () => {
  it("without a key: 401 with a WWW-Authenticate header", async () => {
    const r = await invoices("?month=2026-10");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe('Bearer realm="TicketBay API"');
    expect(r.body.error).toMatch(/API key/);
  });

  it("an unknown key: 401", async () => {
    const r = await invoices("?month=2026-10", "tb_not_a_real_key");
    expect(r.status).toBe(401);
  });

  it("pins current behaviour — suspected bug: any customer's read-only key reads every organizer's invoices, other customers' names and emails included", async () => {
    const ev = await venue(t.db, { id: "a38-night", venue: "A38 Ship" });
    await paidOrder(ev.id, { customerName: "Somebody Else", customerEmail: "somebody@else.example" });
    const r = await invoices("?month=2026-10", await keyHolder("read"));
    expect(r.status).toBe(200);
    expect(r.body.organizers[0].lines[0]).toMatchObject({ customer: "Somebody Else", customerEmail: "somebody@else.example" });
  });
});

describe("GET /api/v1/organizer/invoices — which orders it invoices", () => {
  it("every paid order created in the UTC month, the first millisecond in, the next month's first out", async () => {
    const ev = await venue(t.db, { id: "dome-show", venue: "MVM Dome" });
    const before = await paidOrder(ev.id, { createdAtMs: OCT - 1 });
    const first = await paidOrder(ev.id, { createdAtMs: OCT });
    const last = await paidOrder(ev.id, { createdAtMs: NOV - 1 });
    const after = await paidOrder(ev.id, { createdAtMs: NOV });
    const r = await invoices("?month=2026-10", await keyHolder());
    expect(r.status, r.text).toBe(200);
    expect(lineIds(r.body)).toEqual([first.id, last.id]);
    expect(lineIds(r.body)).not.toContain(before.id);
    expect(lineIds(r.body)).not.toContain(after.id);
  });

  it("leaves out refunded orders", async () => {
    const ev = await venue(t.db, { id: "dome-show", venue: "MVM Dome" });
    const paid = await paidOrder(ev.id);
    await paidOrder(ev.id, { status: "refunded", refundedAtMs: OCT + 3 * 86_400_000, refundCents: 11700 });
    const r = await invoices("?month=2026-10", await keyHolder());
    expect(lineIds(r.body)).toEqual([paid.id]);
    expect(r.body.totals.invoices).toBe(1);
  });

  it("?event= keeps only that event's orders", async () => {
    const a = await venue(t.db, { id: "a38-night", venue: "A38 Ship" });
    const b = await venue(t.db, { id: "dome-show", venue: "MVM Dome" });
    await paidOrder(a.id);
    const mine = await paidOrder(b.id);
    const r = await invoices("?month=2026-10&event=dome-show", await keyHolder());
    expect(lineIds(r.body)).toEqual([mine.id]);
  });

  it("groups by organizer in venue order, lines by order id, with the VAT split of tickets_cents", async () => {
    const dome = await venue(t.db, { id: "dome-show", venue: "MVM Dome" });
    const a38 = await venue(t.db, { id: "a38-night", venue: "A38 Ship" });
    const d1 = await paidOrder(dome.id, { ticketsCents: 999 });
    const a1 = await paidOrder(a38.id, { ticketsCents: 12700 });
    const a2 = await paidOrder(a38.id);
    const r = await invoices("?month=2026-10", await keyHolder());
    expect(r.body.organizers.map((g: { organizer: string }) => g.organizer)).toEqual(["Danube Stage Kft.", "Dome Arena Productions Zrt."]);
    expect(lineIds(r.body)).toEqual([a1.id, a2.id, d1.id]);
    expect(r.body.organizers[0].lines[0]).toMatchObject({ grossCents: 12700, vatCents: 2700, netCents: 10000, discountPercent: 10, date: "2026-10-03", tickets: 2 });
    expect(r.body.totals).toEqual({ invoices: 3, grossCents: 12700 + 11700 + 999, vatCents: 2700 + 2487 + 212, netCents: 10000 + 9213 + 787 });
    expect(r.body.batchId).toBe(`INV-2026-10-${a1.id}`);
    expect(r.body.month).toBe("2026-10");
  });
});

describe("GET /api/v1/organizer/invoices — what it writes", () => {
  it("writes the CSV and the printable copy under reports/, and mails each organizer", async () => {
    const a38 = await venue(t.db, { id: "a38-night", venue: "A38 Ship" });
    const dome = await venue(t.db, { id: "dome-show", venue: "MVM Dome" });
    await paidOrder(a38.id, { customerName: "Csv Check" });
    await paidOrder(dome.id);
    const outbox = path.join(process.cwd(), "reports", "outbox.log");
    const outboxBefore = fs.existsSync(outbox) ? fs.readFileSync(outbox, "utf8").length : 0;

    const r = await invoices("?month=2026-10", await keyHolder());
    expect(r.body.files).toEqual(["reports/invoices-2026-10.csv", "reports/invoices-2026-10.txt"]);
    expect(r.body.emailsSent).toBe(2);
    const csv = fs.readFileSync(path.join(process.cwd(), r.body.files[0]), "utf8");
    expect(csv.trimEnd().split("\n")).toHaveLength(3);
    expect(csv).toContain(",Danube Stage Kft.,56789012-2-43,Csv Check,");
    const txt = fs.readFileSync(path.join(process.cwd(), r.body.files[1]), "utf8");
    expect(txt).toContain("Seller: Dome Arena Productions Zrt.");
    const sent = fs.readFileSync(outbox, "utf8").slice(outboxBefore);
    expect(sent).toContain("To: finance@danubestage.example\nSubject: TicketBay invoices 2026-10 (" + r.body.batchId + ")");
    expect(sent).toContain("To: settlements@domearena.example\n");
  });

  it("pins current behaviour — suspected bug: every GET issues new invoice numbers for the same orders and mails again", async () => {
    const ev = await venue(t.db, { id: "a38-night", venue: "A38 Ship" });
    await paidOrder(ev.id);
    await paidOrder(ev.id);
    const key = await keyHolder();
    const first = await invoices("?month=2026-10", key);
    const second = await invoices("?month=2026-10", key);
    expect(second.body.emailsSent).toBe(1);
    const [a, b] = numbers(first.body).map(seqOf);
    const [c, d] = numbers(second.body).map(seqOf);
    expect(b).toBe(a! + 1);
    expect(c).toBe(b! + 1);
    expect(d).toBe(c! + 1);
  });
});

describe("GET /api/v1/organizer/invoices — the query", () => {
  it("an event id that is not a slug: 404", async () => {
    const r = await invoices("?month=2026-10&event=Not_A_Slug", await keyHolder());
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Event not found." });
  });

  it("a month without the leading zero is the same month", async () => {
    const ev = await venue(t.db, { id: "dome-show", venue: "MVM Dome" });
    const o = await paidOrder(ev.id, { createdAtMs: Date.UTC(2026, 2, 5) });
    const r = await invoices("?month=2026-3", await keyHolder());
    expect(lineIds(r.body)).toEqual([o.id]);
    expect(r.body.month).toBe("2026-03");
  });

  it("pins current behaviour — suspected bug: with no ?month= it exports the server's wall-clock month, not the request's clock", async () => {
    const ev = await venue(t.db, { id: "dome-show", venue: "MVM Dome" });
    const now = new Date();
    await paidOrder(ev.id, { createdAtMs: Date.UTC(now.getFullYear(), now.getMonth(), 1) + 1 });
    const r = await invoices("", await keyHolder());
    expect(r.status, r.text).toBe(200);
    expect(r.body.month).toBe(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  });

  it("pins current behaviour — suspected bug: a month with no paid orders is a 500, not an empty export", async () => {
    const r = await invoices("?month=2026-10", await keyHolder());
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Something went wrong on our side. Try again later." });
  });

  it("pins current behaviour — suspected bug: an unknown (but well-formed) event id is a 500, not a 404", async () => {
    const ev = await venue(t.db, { id: "dome-show", venue: "MVM Dome" });
    await paidOrder(ev.id);
    const r = await invoices("?month=2026-10&event=no-such-event", await keyHolder());
    expect(r.status).toBe(500);
  });

  it("pins current behaviour — suspected bug: a month that is not YYYY-MM is a 500, not a 400", async () => {
    const key = await keyHolder();
    for (const month of ["abc", "2026", "2026-xx"]) {
      const r = await invoices(`?month=${month}`, key);
      expect(r.status, month).toBe(500);
    }
  });

  it("pins current behaviour — suspected bug: month 13 exports January of the next year", async () => {
    const ev = await venue(t.db, { id: "dome-show", venue: "MVM Dome" });
    const o = await paidOrder(ev.id, { createdAtMs: Date.UTC(2027, 0, 10) });
    const r = await invoices("?month=2026-13", await keyHolder());
    expect(r.body.month).toBe("2027-01");
    expect(lineIds(r.body)).toEqual([o.id]);
  });

  it("pins current behaviour — suspected bug: one €0 order (100% discount) in the month makes the whole export a 500", async () => {
    const ev = await venue(t.db, { id: "dome-show", venue: "MVM Dome" });
    await paidOrder(ev.id);
    await paidOrder(ev.id, { ticketsCents: 0, discountCents: 13000, discountPercent: 100, feeCents: 100, totalCents: 100 });
    const r = await invoices("?month=2026-10", await keyHolder());
    expect(r.status).toBe(500);
  });
});
