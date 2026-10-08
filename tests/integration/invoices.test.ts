// The organizer invoice export (src/finance/invoices.ts) over a real Postgres,
// pinned as it behaves today — the suspected bugs included. One month, a few
// venues (a mapped organizer, an unmapped one), hand-built paid orders.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { orders } from "../../src/db/schema";
import { invoiceExport, lastInvoiceExport, type InvoiceExportDeps } from "../../src/finance/invoices";
import { useTestDatabase } from "./database";
import { DAY, NOW, shop, venue } from "./fixtures";

const t = useTestDatabase();

// NOW is 2027-01-15T08:00:00Z: the export month is January 2027.
const JAN = Date.UTC(2027, 0, 1);
const FEB = Date.UTC(2027, 1, 1);

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "invoices-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A running invoice number, from 1. */
const counter = (from = 1) => ({ next: () => from++ });

const deps = (over: Partial<InvoiceExportDeps> = {}): InvoiceExportDeps => ({ db: t.db, nowMs: NOW, dir, sequence: counter(), ...over });

const exportMonth = (params: { month?: string | null; event?: string | null } = { month: "2027-01" }, over: Partial<InvoiceExportDeps> = {}) =>
  invoiceExport(params, deps(over));

const park = () => venue(t.db, { id: "park", venue: "Budapest Park", name: "Park Night" });
const beach = () => venue(t.db, { id: "beach", venue: "Zamárdi Beach", name: "Beach Fest" });
const arena = () => venue(t.db, { id: "arena", venue: "Arena", name: "RockFest 2026" });

let n = 0;
/** A paid order row as checkout writes it: €100.00 of tickets, €3.00 fee, placed at NOW. */
async function order(eventId: string, over: Partial<typeof orders.$inferInsert> = {}) {
  const [row] = await t.db
    .insert(orders)
    .values({
      eventId,
      customerEmail: "fan@example.com",
      customerName: "A Fan",
      quantity: 1,
      subtotalCents: 10_000,
      discountPercent: 0,
      discountCents: 0,
      ticketsCents: 10_000,
      feeCents: 300,
      totalCents: 10_300,
      vatCents: 2_189,
      paymentId: `ch_${++n}`,
      idempotencyKey: `inv-${n}`,
      createdAtMs: NOW,
      ...over,
    })
    .returning();
  return row!;
}

const pad5 = (id: number) => String(id).padStart(5, "0");
const file = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
const csv = () => file("invoices-2027-01.csv");
const txt = () => file("invoices-2027-01.txt");
const outbox = () => file("outbox.log");
const sp = (count: number) => " ".repeat(count);

const CSV_HEADER = "batch_id,invoice_no,order_no,date,organizer,organizer_tax_no,customer,event,tickets,discount_pct,net_eur,vat_eur,gross_eur,vat_rate\n";

/** Does this runtime honour a TZ change? 12:00 UTC on 31 January is 1 February on Kiritimati (UTC+14). */
function tzChangeWorks(): boolean {
  const tz = process.env.TZ;
  process.env.TZ = "Pacific/Kiritimati";
  try {
    return new Date(Date.UTC(2027, 0, 31, 12)).getDate() === 1;
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
}

describe("which orders are invoiced", () => {
  it("one line per paid order of the month, one block per organizer, blocks in venue order and lines in order-id order", async () => {
    await park();
    await beach();
    await arena();
    const a1 = await order("arena");
    const p1 = await order("park");
    const b1 = await order("beach");
    const p2 = await order("park");

    const r = await exportMonth();

    expect(r.organizers.map((g: { organizer: string }) => g.organizer)).toEqual(["Arena", "Park Live Events Kft.", "Lakeside Festivals Kft."]);
    expect(r.organizers.map((g: { lines: { orderId: number }[] }) => g.lines.map((l) => l.orderId))).toEqual([[a1.id], [p1.id, p2.id], [b1.id]]);
    expect(r.totals.invoices).toBe(4);
    expect(r.month).toBe("2027-01");
    expect(r.generatedAt).toBe(new Date(NOW).toISOString());
  });

  it("the batch id is the month plus the id of the first order on the export", async () => {
    await park();
    await order("park");
    const second = await order("park", { createdAtMs: JAN });
    const r = await exportMonth();
    // first by venue then by id, not by date
    expect(r.batchId).toBe(`INV-2027-01-${second.id - 1}`);
  });

  it("the month window: the first instant of the month is in, the first instant of the next month is out", async () => {
    await park();
    const atStart = await order("park", { createdAtMs: JAN });
    const atEnd = await order("park", { createdAtMs: FEB - 1 });
    await order("park", { createdAtMs: JAN - 1 });
    await order("park", { createdAtMs: FEB });

    const r = await exportMonth();
    expect(r.organizers[0].lines.map((l: { orderId: number }) => l.orderId)).toEqual([atStart.id, atEnd.id]);
  });

  it("leaves refunded orders out", async () => {
    await park();
    const paid = await order("park");
    await order("park", { status: "refunded", refundedAtMs: NOW + DAY, refundCents: 9_800, refundFeeCents: 200, refundReason: "customer" });
    const r = await exportMonth();
    expect(r.organizers[0].lines.map((l: { orderId: number }) => l.orderId)).toEqual([paid.id]);
    expect(r.totals.invoices).toBe(1);
  });

  it("?event= limits the export to that event; event null means every event", async () => {
    await park();
    await beach();
    const p = await order("park");
    await order("beach");
    const one = await exportMonth({ month: "2027-01", event: "park" });
    expect(one.organizers.map((g: { organizer: string }) => g.organizer)).toEqual(["Park Live Events Kft."]);
    expect(one.organizers[0].lines.map((l: { orderId: number }) => l.orderId)).toEqual([p.id]);
    const all = await exportMonth({ month: "2027-01", event: null });
    expect(all.totals.invoices).toBe(2);
  });

  it("a month with no paid orders is an empty export: no block, zero totals, header-only files, no mail, batch INV-YYYY-MM-0", async () => {
    await park();
    await order("park", { createdAtMs: FEB });
    const r = await exportMonth({ month: "2027-01" });
    expect(r).toMatchObject({ batchId: "INV-2027-01-0", month: "2027-01", organizers: [], totals: { invoices: 0, netCents: 0, vatCents: 0, grossCents: 0 }, emailsSent: 0 });
    expect(csv()).toBe(CSV_HEADER);
    expect(txt()).toBe("TICKETBAY - ORGANIZER INVOICES 2027-01\n" + `Batch INV-2027-01-0   generated ${new Date(NOW).toISOString()}\n\n`);
    expect(fs.existsSync(path.join(dir, "outbox.log"))).toBe(false);
    const none = await exportMonth({ month: "2027-02", event: "no-such-event" });
    expect(none.totals.invoices).toBe(0);
  });

  it("the month defaults to the clock's month; the title and the subject carry it unpadded", async () => {
    await park();
    await order("park");
    const r = await invoiceExport({}, deps());
    expect(r.month).toBe("2027-01");
    expect(r.totals.invoices).toBe(1);
    expect(txt()).toMatch(/^TICKETBAY - ORGANIZER INVOICES 2027-1\n/);
    expect(outbox()).toContain("Subject: TicketBay invoices 2027-1 (INV-2027-01-1)\n");
  });

  it("takes the month as 2027-1 or 2027-01-15 too, and exports January", async () => {
    await park();
    await order("park");
    for (const month of ["2027-1", "2027-01-15"]) {
      const r = await exportMonth({ month });
      expect(r.month).toBe("2027-01");
      expect(r.totals.invoices).toBe(1);
      expect(r.files[0]).toMatch(/invoices-2027-01\.csv$/);
    }
  });
});

describe("the money on a line", () => {
  it("a line carries the order's tickets amount as the gross, split into net and VAT 27% — the service fee is not invoiced", async () => {
    await park();
    const o = await order("park", {
      quantity: 2,
      subtotalCents: 12_345,
      ticketsCents: 12_345,
      feeCents: 370,
      totalCents: 12_715,
      customerName: "Kiss Anna",
      customerEmail: "anna@example.com",
    });
    const r = await exportMonth();
    expect(r.organizers[0].lines[0]).toEqual({
      invoiceNo: "TB-202701-000001",
      orderId: o.id,
      orderNumber: `TB-${pad5(o.id)}`,
      date: "2027-01-15",
      customer: "Kiss Anna",
      customerEmail: "anna@example.com",
      eventId: "park",
      eventName: "Park Night",
      tickets: 2,
      discountPercent: 0,
      netCents: 9_720,
      vatCents: 2_625,
      grossCents: 12_345,
    });
  });

  it("a real checkout order lands with its discounted tickets amount, not with the charged total", async () => {
    const s = shop(t.db);
    const ev = await venue(t.db, { id: "park", venue: "Budapest Park", priceCents: 5_000 });
    s.setClock(NOW);
    const { order: o } = await s.book(ev.id, 5); // 5 tickets: group discount 5%
    expect(o).toMatchObject({ subtotalCents: 25_000, discountCents: 1_250, ticketsCents: 23_750, feeCents: 713, totalCents: 24_463 });

    const r = await exportMonth();
    expect(r.organizers[0].lines[0]).toMatchObject({ grossCents: 23_750, vatCents: 5_049, netCents: 18_701, discountPercent: 5, tickets: 5 });
  });

  it("a free order (100% discount) is invoiced at 0.00 net, 0.00 VAT and 0.00 gross", async () => {
    await park();
    const o = await order("park", { discountPercent: 100, discountCents: 10_000, ticketsCents: 0, totalCents: 100, feeCents: 100 });
    const r = await exportMonth();
    expect(r.organizers[0].lines[0]).toMatchObject({ netCents: 0, vatCents: 0, grossCents: 0, discountPercent: 100 });
    expect(r.totals).toEqual({ invoices: 1, netCents: 0, vatCents: 0, grossCents: 0 });
    expect(csv()).toContain(",1,100,0.00,0.00,0.00,27%\n");
    expect(txt()).toContain("TB-202701-000001" + sp(4) + `TB-${pad5(o.id)}` + sp(2) + "A Fan" + sp(19) + "1" + sp(4) + "        0.00" + "        0.00" + "        0.00\n");
  });

  it("an order of 1 cent has a VAT of 0 cents and a net of 1 cent", async () => {
    await park();
    await order("park", { subtotalCents: 1, ticketsCents: 1, feeCents: 100, totalCents: 101 });
    const r = await exportMonth();
    expect(r.organizers[0].lines[0]).toMatchObject({ netCents: 1, vatCents: 0, grossCents: 1 });
    expect(txt()).toContain("        0.01" + "        0.00" + "        0.01\n");
  });

  it("discount_pct is recomputed from the cents, rounded to a whole percent", async () => {
    await park();
    await order("park", { subtotalCents: 10_000, discountPercent: 15, discountCents: 1_500, ticketsCents: 8_500 });
    await order("park", { quantity: 3, subtotalCents: 9_999, discountPercent: 10, discountCents: 1_000, ticketsCents: 8_999 });
    const r = await exportMonth();
    expect(r.organizers[0].lines.map((l: { discountPercent: number }) => l.discountPercent)).toEqual([15, 10]);
  });

  it("adds up net, VAT and gross per organizer and over the whole batch", async () => {
    await park();
    await arena();
    await order("park");
    await order("park", { subtotalCents: 12_345, ticketsCents: 12_345 });
    await order("arena");
    const r = await exportMonth();
    const parkBlock = r.organizers.find((g: { organizer: string }) => g.organizer === "Park Live Events Kft.");
    expect(parkBlock).toMatchObject({ netCents: 17_594, vatCents: 4_751, grossCents: 22_345 });
    expect(r.totals).toEqual({ invoices: 3, netCents: 25_468, vatCents: 6_877, grossCents: 32_345 });
  });
});

describe("invoice numbers", () => {
  it("numbers the lines TB-YYYYMM-000001 onward, in export order across the organizer blocks", async () => {
    await park();
    await beach();
    await arena();
    await order("arena");
    await order("park");
    await order("beach");
    const r = await exportMonth();
    expect(r.organizers.map((g: { lines: { invoiceNo: string }[] }) => g.lines.map((l) => l.invoiceNo))).toEqual([
      ["TB-202701-000001"],
      ["TB-202701-000002"],
      ["TB-202701-000003"],
    ]);
  });

  it("continues where the previous export stopped; pins current behaviour — suspected bug: a re-run of the same month gives the same orders new numbers", async () => {
    await park();
    await order("park");
    await order("park");
    const sequence = counter();
    const numbers = (r: { organizers: { lines: { invoiceNo: string }[] }[] }) => r.organizers.flatMap((g) => g.lines.map((l) => l.invoiceNo));

    expect(numbers(await exportMonth(undefined, { sequence }))).toEqual(["TB-202701-000001", "TB-202701-000002"]);
    expect(numbers(await exportMonth(undefined, { sequence }))).toEqual(["TB-202701-000003", "TB-202701-000004"]);
  });

  it("the app's own running number starts at 1 for this process and keeps counting", async () => {
    await park();
    await order("park");
    const { sequence: _ignored, ...withoutSequence } = deps();
    const first = await invoiceExport({ month: "2027-01" }, withoutSequence);
    const second = await invoiceExport({ month: "2027-01" }, withoutSequence);
    expect(first.organizers[0].lines[0].invoiceNo).toBe("TB-202701-000001");
    expect(second.organizers[0].lines[0].invoiceNo).toBe("TB-202701-000002");
  });
});

describe("who is the seller", () => {
  it("a known venue is invoiced under its organizer: name, e-mail and tax number", async () => {
    await park();
    await order("park");
    const r = await exportMonth();
    expect(r.organizers[0]).toMatchObject({ organizer: "Park Live Events Kft.", email: "finance@parklive.example", taxNo: "12345678-2-42" });
    expect(txt()).toContain("Seller: Park Live Events Kft.  (tax no. 12345678-2-42)\n");
    expect(csv()).toContain(",Park Live Events Kft.,12345678-2-42,");
  });

  it("every known venue is invoiced under its organizer: name, e-mail and tax number", async () => {
    const table: Record<string, { organizer: string; email: string; taxNo: string }> = {
      "Budapest Park": { organizer: "Park Live Events Kft.", email: "finance@parklive.example", taxNo: "12345678-2-42" },
      "Zamárdi Beach": { organizer: "Lakeside Festivals Kft.", email: "accounts@lakeside-fest.example", taxNo: "23456789-2-14" },
      "Hungexpo Hall G": { organizer: "CraftConf Szervező Kft.", email: "billing@craftconf.example", taxNo: "34567890-2-41" },
      "MVM Dome": { organizer: "Dome Arena Productions Zrt.", email: "settlements@domearena.example", taxNo: "45678901-2-43" },
      "Kisüzem": { organizer: "Kisüzem Kulturális Egyesület", email: "hello@kisuzem.example", taxNo: "18765432-1-42" },
      "A38 Ship": { organizer: "Danube Stage Kft.", email: "finance@danubestage.example", taxNo: "56789012-2-43" },
      "Opus Jazz Club": { organizer: "Opus Music Kft.", email: "office@opusmusic.example", taxNo: "67890123-2-42" },
    };
    for (const [i, v] of Object.keys(table).entries()) {
      await venue(t.db, { id: `v${i}`, venue: v });
      await order(`v${i}`);
    }
    const r = await exportMonth();
    const seen = Object.fromEntries(
      r.organizers.map((g: { organizer: string; email: string; taxNo: string; lines: { eventId: string }[] }) => [g.lines[0]!.eventId, { organizer: g.organizer, email: g.email, taxNo: g.taxNo }]),
    );
    expect(seen).toEqual(Object.fromEntries(Object.keys(table).map((v, i) => [`v${i}`, table[v]])));
  });

  it("pins current behaviour — suspected bug: Dumaszínház is an organizer in the payout report (payouts.ts) but not here, so its invoices go out under the venue name to the TicketBay address", async () => {
    await venue(t.db, { id: "duma", venue: "Dumaszínház" });
    await order("duma");
    const r = await exportMonth();
    expect(r.organizers[0]).toMatchObject({ organizer: "Dumaszínház", email: "invoices@ticketbay.example", taxNo: "" });
  });

  it("an unknown venue is invoiced under its own name, without a tax number, to the TicketBay invoices address", async () => {
    await arena();
    await order("arena");
    const r = await exportMonth();
    expect(r.organizers[0]).toMatchObject({ organizer: "Arena", email: "invoices@ticketbay.example", taxNo: "" });
    expect(txt()).toContain("Seller: Arena\n");
    expect(csv()).toContain(",Arena,,");
  });
});

describe("the CSV for the accountants", () => {
  it("one header, then one line per invoice with the amounts in euros to two decimals", async () => {
    await arena();
    const o = await order("arena");
    await exportMonth();
    expect(csv()).toBe(CSV_HEADER + `INV-2027-01-${o.id},TB-202701-000001,TB-${pad5(o.id)},2027-01-15,Arena,,A Fan,RockFest 2026,1,0,78.74,21.26,100.00,27%\n`);
  });

  it("quotes an organizer, a customer or an event name that holds a comma, a quote or a line break", async () => {
    await venue(t.db, { id: "odd", venue: "Foo, Bar", name: "Line\nBreak Fest" });
    const o = await order("odd", { customerName: 'Kovács, "Jr." Ádám' });
    await exportMonth();
    expect(csv()).toBe(CSV_HEADER + `INV-2027-01-${o.id},TB-202701-000001,TB-${pad5(o.id)},2027-01-15,"Foo, Bar",,"Kovács, ""Jr."" Ádám","Line\nBreak Fest",1,0,78.74,21.26,100.00,27%\n`);
  });
});

describe("the printable copy", () => {
  it("one block per organizer: a seller header, a column header, the lines, a total line and the VAT note", async () => {
    await park();
    const o = await order("park");
    await exportMonth();
    const header = "Invoice" + sp(13) + "Order" + sp(5) + "Customer" + sp(16) + "Qty  " + "         Net" + "         VAT" + "       Gross\n";
    const line = "TB-202701-000001" + sp(4) + `TB-${pad5(o.id)}` + sp(2) + "A Fan" + sp(19) + "1" + sp(4) + "       78.74" + "       21.26" + "      100.00\n";
    const total = "Total" + sp(54) + "       78.74" + "       21.26" + "      100.00\n";
    expect(txt()).toBe(
      "TICKETBAY - ORGANIZER INVOICES 2027-01\n" +
        `Batch INV-2027-01-${o.id}   generated ${new Date(NOW).toISOString()}\n\n` +
        "=".repeat(96) + "\n" +
        "Seller: Park Live Events Kft.  (tax no. 12345678-2-42)\n" +
        "=".repeat(96) + "\n" +
        header +
        line +
        "-".repeat(96) + "\n" +
        total +
        "VAT 27% included in the gross amounts.\n\n",
    );
  });

  it("cuts a customer name longer than its column to 23 characters and an ellipsis", async () => {
    await park();
    await order("park", { customerName: "Dr. Nagy-Kovács Erzsébet Mária" });
    await exportMonth();
    expect(txt()).toContain("  Dr. Nagy-Kovács Erzsébe…1    ");
  });

  it("prints a customer name of exactly 24 characters whole, and cuts one of 25", async () => {
    await park();
    await order("park", { customerName: "Nagy-Kovács Erzsébet Már" });
    await order("park", { customerName: "Nagy-Kovács Erzsébet Mári" });
    await exportMonth();
    expect(txt()).toContain("  Nagy-Kovács Erzsébet Már1    ");
    expect(txt()).toContain("  Nagy-Kovács Erzsébet Má…1    ");
  });

  it("amounts under one euro and zero amounts are right-aligned like the others", async () => {
    await park();
    const o = await order("park", { subtotalCents: 50, ticketsCents: 50, feeCents: 100, totalCents: 150 });
    await exportMonth();
    expect(txt()).toContain("TB-202701-000001" + sp(4) + `TB-${pad5(o.id)}` + sp(2) + "A Fan" + sp(19) + "1" + sp(4) + "        0.39" + "        0.11" + "        0.50\n");
  });
});

describe("the files and the mails", () => {
  it("creates the folder, nested too, when it does not exist yet", async () => {
    await park();
    await order("park");
    const nested = path.join(dir, "finance", "2027");
    await exportMonth(undefined, { dir: nested });
    expect(fs.existsSync(path.join(nested, "invoices-2027-01.csv"))).toBe(true);
    expect(fs.existsSync(path.join(nested, "invoices-2027-01.txt"))).toBe(true);
    expect(fs.existsSync(path.join(nested, "outbox.log"))).toBe(true);
  });

  it("writes invoices-YYYY-MM.csv and .txt into the folder and lists them relative to the working directory", async () => {
    await park();
    await order("park");
    const r = await exportMonth();
    const csvFile = path.join(dir, "invoices-2027-01.csv");
    const txtFile = path.join(dir, "invoices-2027-01.txt");
    expect(r.files).toEqual([path.relative(process.cwd(), csvFile), path.relative(process.cwd(), txtFile)]);
    expect(fs.existsSync(csvFile)).toBe(true);
    expect(fs.existsSync(txtFile)).toBe(true);
  });

  it("mails every organizer its block: the counts, the sums, the first and the last invoice number", async () => {
    await park();
    await order("park");
    const o = await order("park", { subtotalCents: 12_345, ticketsCents: 12_345 });
    const r = await exportMonth();
    expect(r.emailsSent).toBe(1);
    expect(outbox()).toBe(
      "To: finance@parklive.example\n" +
        `Subject: TicketBay invoices 2027-01 (INV-2027-01-${o.id - 1})\n` +
        `Date: ${new Date(NOW).toUTCString()}\n\n` +
        "Dear Park Live Events Kft.,\n\n" +
        "attached are the ticket invoices TicketBay issued in your name for 2027-01.\n\n" +
        "  invoices:  2\n" +
        "  net:             175.94 EUR\n" +
        "  VAT 27%:          47.51 EUR\n" +
        "  gross:           223.45 EUR\n\n" +
        "First invoice: TB-202701-000001, last invoice: TB-202701-000002\n" +
        "\nThanks,\nTicketBay Finance\n" +
        "\n-----\n",
    );
  });

  it("one mail per organizer, in block order", async () => {
    await park();
    await arena();
    await order("park");
    await order("arena");
    const r = await exportMonth();
    expect(r.emailsSent).toBe(2);
    expect(outbox().match(/^To: .*$/gm)).toEqual(["To: invoices@ticketbay.example", "To: finance@parklive.example"]);
  });

  it("keeps the last export in lastInvoiceExport", async () => {
    await park();
    await order("park");
    const r = await exportMonth();
    expect(lastInvoiceExport).toBe(r);
  });
});

describe("pins current behaviour — suspected bugs", () => {
  it("suspected bug (function level): a month that is not YYYY-MM throws RangeError (Invalid time value) — the route refuses those with a 400 before the export", async () => {
    await park();
    await order("park");
    for (const month of ["banana", "2027", "2027-", "-1-1"]) {
      await expect(exportMonth({ month }), month).rejects.toThrow(RangeError);
    }
  });

  it("suspected bug: a venue named toString (any Object.prototype member) crashes the export — the organizer groups are a plain object", async () => {
    await venue(t.db, { id: "proto", venue: "toString" });
    await order("proto");
    await expect(exportMonth()).rejects.toThrow(TypeError);
  });

  it("suspected bug: a venue named constructor is invoiced under 'Object' with no address — the organizer table is a plain object", async () => {
    await venue(t.db, { id: "proto", venue: "constructor" });
    await order("proto");
    const r = await exportMonth();
    expect(r.organizers[0]).toMatchObject({ organizer: "Object", email: undefined, taxNo: undefined });
    expect(outbox()).toMatch(/^To: undefined\n/);
  });

  it("suspected bug: an order with a 0 subtotal (a free event) gets discount_pct NaN", async () => {
    await park();
    await order("park", { subtotalCents: 0, discountCents: 0, ticketsCents: 0, totalCents: 100, feeCents: 100 });
    const r = await exportMonth();
    expect(Number.isNaN(r.organizers[0].lines[0].discountPercent)).toBe(true);
    expect(csv()).toContain(",1,NaN,0.00,0.00,0.00,27%\n");
  });

  it("suspected bug: month 2027-13 exports January 2028 under the name 2027-13", async () => {
    await park();
    const o = await order("park", { createdAtMs: Date.UTC(2028, 0, 10) });
    const r = await exportMonth({ month: "2027-13" });
    expect(r.month).toBe("2028-01");
    expect(r.organizers[0].lines.map((l: { orderId: number }) => l.orderId)).toEqual([o.id]);
    expect(file("invoices-2028-01.txt")).toMatch(/^TICKETBAY - ORGANIZER INVOICES 2027-13\n/);
  });


  // The pin needs another time zone at run time. Node honours a TZ change in
  // the main thread, not in a worker thread (process.env is a copy there), so
  // under Stryker's vitest runner the pin is skipped, not red.
  it.skipIf(!tzChangeWorks())("suspected bug: the default month follows the server's time zone while the window is UTC", async () => {
    const tz = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14
    try {
      await park();
      await order("park", { createdAtMs: Date.UTC(2027, 0, 31, 10) });
      const feb = await order("park", { createdAtMs: Date.UTC(2027, 1, 5) });
      // 12:00 UTC on 31 January is already 1 February on Kiritimati
      const r = await invoiceExport({}, deps({ nowMs: Date.UTC(2027, 0, 31, 12) }));
      expect(r.month).toBe("2027-02");
      expect(r.organizers[0].lines.map((l: { orderId: number }) => l.orderId)).toEqual([feb.id]);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});
