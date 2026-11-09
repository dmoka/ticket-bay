// Characterization tests for the organizer invoice export (src/domain/invoice-export.ts):
// what the export produces today, from the paid order rows the endpoint reads.
// Tests named "pins current behaviour — suspected bug: …" pin today's result on
// purpose; fixing them is a separate change.
import { describe, it, expect } from "vitest";
import { buildInvoiceExport, invoiceMonth, type InvoiceOrderRow } from "../../src/domain/invoice-export";

const NOW = new Date("2026-11-01T08:00:00.000Z");

function row(over: Partial<InvoiceOrderRow> = {}): InvoiceOrderRow {
  return {
    id: 7,
    event_id: "jazz-night",
    event_name: "Jazz Night",
    venue: "Opus Jazz Club",
    customer_name: "Anna Kovács",
    customer_email: "anna@example.com",
    quantity: 2,
    subtotal_cents: "13000",
    discount_cents: "1300",
    tickets_cents: "11700",
    created_at_ms: String(Date.UTC(2026, 9, 3, 23, 30)),
    ...over,
  };
}

function exportOf(rows: InvoiceOrderRow[], month = "2026-10", firstSeq = 1) {
  let seq = firstSeq;
  return buildInvoiceExport({ rows, month, now: NOW, nextInvoiceSeq: () => seq++ });
}

const csvLines = (csv: string) => csv.trimEnd().split("\n").slice(1);

describe("invoice lines: net, VAT 27% and gross", () => {
  it("splits the ticket amount (gross, VAT included) into net and VAT, in cents", () => {
    const [line] = exportOf([row({ tickets_cents: "11700" })]).result.organizers[0].lines;
    expect(line).toMatchObject({ grossCents: 11700, vatCents: 2487, netCents: 9213 });
  });

  it("rounds the VAT to the nearest cent and puts the rest in net", () => {
    const [line] = exportOf([row({ tickets_cents: "999" })]).result.organizers[0].lines;
    expect(line).toMatchObject({ grossCents: 999, vatCents: 212, netCents: 787 });
  });

  it("a whole multiple of 1.27 splits exactly", () => {
    const [line] = exportOf([row({ tickets_cents: "12700" })]).result.organizers[0].lines;
    expect(line).toMatchObject({ grossCents: 12700, vatCents: 2700, netCents: 10000 });
  });

  it("pins current behaviour — suspected bug: on a very large order the VAT is a cent off (floating point, found by the invariant properties)", () => {
    // 27/127 of 41 382 722 064 805 cents is 8 797 901 541 336.496…, which rounds to …336; the export says …337.
    // The booking path accepts ticket amounts up to Number.MAX_SAFE_INTEGER.
    const [line] = exportOf([row({ tickets_cents: "41382722064805" })]).result.organizers[0].lines;
    expect(line).toMatchObject({ vatCents: 8797901541337, netCents: 32584820523468 });
  });

  it("invoices the tickets only: gross is tickets_cents whatever the subtotal and discount", () => {
    const [line] = exportOf([row({ subtotal_cents: "20000", discount_cents: "5000", tickets_cents: "15000" })]).result.organizers[0].lines;
    expect(line.grossCents).toBe(15000);
  });

  it("accepts the BIGINT columns as numbers as well as strings", () => {
    const asNumbers = exportOf([row({ tickets_cents: 11700, subtotal_cents: 13000, discount_cents: 1300, created_at_ms: Date.UTC(2026, 9, 3) })]);
    expect(asNumbers.result.organizers[0].lines[0]).toMatchObject({ grossCents: 11700, vatCents: 2487, discountPercent: 10, date: "2026-10-03" });
  });

  it("copies the order, customer and event onto the line", () => {
    const [line] = exportOf([row()]).result.organizers[0].lines;
    expect(line).toEqual({
      invoiceNo: "TB-202610-000001",
      orderId: 7,
      orderNumber: "TB-00007",
      date: "2026-10-03",
      customer: "Anna Kovács",
      customerEmail: "anna@example.com",
      eventId: "jazz-night",
      eventName: "Jazz Night",
      tickets: 2,
      discountPercent: 10,
      netCents: 9213,
      vatCents: 2487,
      grossCents: 11700,
    });
  });

  it("dates the line by the order's UTC day", () => {
    const [line] = exportOf([row({ created_at_ms: String(Date.UTC(2026, 9, 31, 23, 59, 59, 999)) })]).result.organizers[0].lines;
    expect(line.date).toBe("2026-10-31");
  });

  it("order numbers are TB- and the id padded to 5 digits, longer ids unpadded", () => {
    const lines = exportOf([row({ id: 3 }), row({ id: 123456 })]).result.organizers[0].lines;
    expect(lines.map((l: { orderNumber: string }) => l.orderNumber)).toEqual(["TB-00003", "TB-123456"]);
  });

  it("the discount percent is discount / subtotal, rounded to a whole percent", () => {
    const pct = (discount: string, subtotal: string) =>
      exportOf([row({ discount_cents: discount, subtotal_cents: subtotal })]).result.organizers[0].lines[0].discountPercent;
    expect(pct("1300", "13000")).toBe(10);
    expect(pct("0", "13000")).toBe(0);
    expect(pct("13000", "13000")).toBe(100);
    expect(pct("150", "1000")).toBe(15);
    expect(pct("146", "1000")).toBe(15);
    expect(pct("144", "1000")).toBe(14);
    expect(pct("125", "1000")).toBe(13); // 12.5 rounds up
  });

  it("pins current behaviour — suspected bug: an exact 14.5% rounds down, the division lands on 14.4999…", () => {
    const line = exportOf([row({ discount_cents: "145", subtotal_cents: "1000" })]).result.organizers[0].lines[0];
    expect(line.discountPercent).toBe(14);
  });
});

describe("invoice numbers", () => {
  it("are TB-<yyyymm>-<running number padded to 6>, one per line in row order", () => {
    const r = exportOf([row({ id: 1 }), row({ id: 2 }), row({ id: 3, venue: "MVM Dome" })], "2026-10", 41);
    const numbers = r.result.organizers.flatMap((g: { lines: { invoiceNo: string }[] }) => g.lines.map((l) => l.invoiceNo));
    expect(numbers).toEqual(["TB-202610-000041", "TB-202610-000042", "TB-202610-000043"]);
  });

  it("take one number from the running counter per line, no more", () => {
    let calls = 0;
    buildInvoiceExport({ rows: [row(), row(), row()], month: "2026-10", now: NOW, nextInvoiceSeq: () => ++calls });
    expect(calls).toBe(3);
  });

  it("numbers past 999999 are not cut", () => {
    expect(exportOf([row()], "2026-10", 1234567).result.organizers[0].lines[0].invoiceNo).toBe("TB-202610-1234567");
  });
});

describe("organizers", () => {
  it("each venue's lines go to its organizer, with the organizer's email and tax number", () => {
    const [g] = exportOf([row({ venue: "Budapest Park" })]).result.organizers;
    expect(g).toMatchObject({ organizer: "Park Live Events Kft.", email: "finance@parklive.example", taxNo: "12345678-2-42" });
  });

  it("knows the organizer of every venue on the list", () => {
    const venues = ["Budapest Park", "Zamárdi Beach", "Hungexpo Hall G", "MVM Dome", "Kisüzem", "A38 Ship", "Opus Jazz Club"];
    const r = exportOf(venues.map((venue, i) => row({ id: i + 1, venue })));
    expect(r.result.organizers.map((g: { organizer: string; email: string; taxNo: string }) => [g.organizer, g.email, g.taxNo])).toEqual([
      ["Park Live Events Kft.", "finance@parklive.example", "12345678-2-42"],
      ["Lakeside Festivals Kft.", "accounts@lakeside-fest.example", "23456789-2-14"],
      ["CraftConf Szervező Kft.", "billing@craftconf.example", "34567890-2-41"],
      ["Dome Arena Productions Zrt.", "settlements@domearena.example", "45678901-2-43"],
      ["Kisüzem Kulturális Egyesület", "hello@kisuzem.example", "18765432-1-42"],
      ["Danube Stage Kft.", "finance@danubestage.example", "56789012-2-43"],
      ["Opus Music Kft.", "office@opusmusic.example", "67890123-2-42"],
    ]);
  });

  it("a venue not on the list is its own organizer, mailed to TicketBay's invoice inbox, with no tax number", () => {
    const [g] = exportOf([row({ venue: "Brand New Hall" })]).result.organizers;
    expect(g).toMatchObject({ organizer: "Brand New Hall", email: "invoices@ticketbay.example", taxNo: "" });
  });

  it("groups by organizer in the order they first appear, and sums each organizer's lines", () => {
    const r = exportOf([
      row({ id: 1, venue: "A38 Ship", tickets_cents: "12700" }),
      row({ id: 2, venue: "MVM Dome", tickets_cents: "999" }),
      row({ id: 3, venue: "A38 Ship", tickets_cents: "11700" }),
    ]);
    expect(r.result.organizers.map((g: { organizer: string }) => g.organizer)).toEqual(["Danube Stage Kft.", "Dome Arena Productions Zrt."]);
    const [danube, dome] = r.result.organizers;
    expect(danube.lines.map((l: { orderId: number }) => l.orderId)).toEqual([1, 3]);
    expect(danube).toMatchObject({ grossCents: 24400, vatCents: 2700 + 2487, netCents: 10000 + 9213 });
    expect(dome).toMatchObject({ grossCents: 999, vatCents: 212, netCents: 787 });
  });

  it("two venues of the same organizer name share one block", () => {
    const r = exportOf([row({ id: 1, venue: "Danube Stage Kft." }), row({ id: 2, venue: "A38 Ship" })]);
    expect(r.result.organizers).toHaveLength(1);
    expect(r.result.organizers[0].lines).toHaveLength(2);
    // the block keeps the first one's details: the unknown venue's inbox and empty tax number
    expect(r.result.organizers[0]).toMatchObject({ email: "invoices@ticketbay.example", taxNo: "" });
  });
});

describe("the result", () => {
  it("totals every line of every organizer", () => {
    const r = exportOf([row({ id: 1, venue: "A38 Ship", tickets_cents: "12700" }), row({ id: 2, venue: "MVM Dome", tickets_cents: "999" })]);
    expect(r.result.totals).toEqual({ invoices: 2, netCents: 10787, vatCents: 2912, grossCents: 13699 });
  });

  it("names the batch by the month and the first row's order id", () => {
    expect(exportOf([row({ id: 42 }), row({ id: 7 })]).result.batchId).toBe("INV-2026-10-42");
  });

  it("carries the month as YYYY-MM and the time it was generated", () => {
    const r = exportOf([row()], "2026-3");
    expect(r.result.month).toBe("2026-03");
    expect(r.result.generatedAt).toBe("2026-11-01T08:00:00.000Z");
    expect(r.result.batchId).toBe("INV-2026-03-7");
    expect(r.result.organizers[0].lines[0].invoiceNo).toBe("TB-202603-000001");
  });

  it("has exactly these fields, in this order", () => {
    expect(Object.keys(exportOf([row()]).result)).toEqual(["batchId", "month", "generatedAt", "organizers", "totals"]);
    expect(Object.keys(exportOf([row()]).result.organizers[0])).toEqual(["organizer", "email", "taxNo", "lines", "netCents", "vatCents", "grossCents"]);
  });
});

describe("invoiceMonth", () => {
  it("is the UTC month, start included, next month's start excluded", () => {
    expect(invoiceMonth("2026-10")).toEqual({ start: new Date("2026-10-01T00:00:00.000Z"), end: new Date("2026-11-01T00:00:00.000Z") });
  });

  it("December ends at the next year's January", () => {
    expect(invoiceMonth("2026-12").end).toEqual(new Date("2027-01-01T00:00:00.000Z"));
  });

  it("pins current behaviour — suspected bug: a year below 100 means 19xx (0099-10 is October 1999)", () => {
    expect(invoiceMonth("0099-10").start).toEqual(new Date("1999-10-01T00:00:00.000Z"));
    expect(invoiceMonth("26-10").start).toEqual(new Date("1926-10-01T00:00:00.000Z"));
  });

  it("accepts a month without the leading zero", () => {
    expect(invoiceMonth("2026-1").start).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  });
});

describe("the CSV", () => {
  it("has a header and one row per line, organizer by organizer", () => {
    const r = exportOf([row({ id: 1, venue: "A38 Ship" }), row({ id: 2, venue: "MVM Dome" }), row({ id: 3, venue: "A38 Ship" })]);
    const lines = r.csv.trimEnd().split("\n");
    expect(lines[0]).toBe("batch_id,invoice_no,order_no,date,organizer,organizer_tax_no,customer,event,tickets,discount_pct,net_eur,vat_eur,gross_eur,vat_rate");
    expect(lines.slice(1).map((l) => l.split(",")[2])).toEqual(["TB-00001", "TB-00003", "TB-00002"]);
    expect(r.csv.endsWith("\n")).toBe(true);
  });

  it("writes amounts in euros with two decimals and the 27% rate", () => {
    expect(csvLines(exportOf([row()]).csv)).toEqual([
      "INV-2026-10-7,TB-202610-000001,TB-00007,2026-10-03,Opus Music Kft.,67890123-2-42,Anna Kovács,Jazz Night,2,10,92.13,24.87,117.00,27%",
    ]);
  });

  it("leaves the tax number empty for an unknown venue", () => {
    expect(csvLines(exportOf([row({ venue: "Brand New Hall" })]).csv)[0]).toContain(",Brand New Hall,,Anna Kovács,");
  });

  it("quotes a field with a comma, a quote or a newline, doubling the quotes", () => {
    const [line] = csvLines(exportOf([row({ customer_name: 'Kovács, "Anni"', event_name: "Jazz\nNight" })]).csv.replace("Jazz\nNight", "Jazz<NL>Night"));
    expect(line).toContain(',"Kovács, ""Anni""","Jazz<NL>Night",');
    expect(exportOf([row({ event_name: "Jazz\nNight" })]).csv).toContain(',"Jazz\nNight",');
  });

  it("pins current behaviour — suspected bug: a customer name starting with = is written as is, a formula when the accountants open the CSV", () => {
    const [line] = csvLines(exportOf([row({ customer_name: "=HYPERLINK(1)" })]).csv);
    expect(line).toContain(",=HYPERLINK(1),");
  });
});

describe("the printable copy", () => {
  it("is the heading, then one block per organizer with its lines and its total", () => {
    const r = exportOf([row(), row({ id: 9, venue: "Somewhere New", customer_name: "A very long customer name indeed", quantity: 1, tickets_cents: "999", discount_cents: "0", subtotal_cents: "999" })]);
    const rule = "=".repeat(96);
    const dash = "-".repeat(96);
    expect(r.txt).toBe(
      "TICKETBAY - ORGANIZER INVOICES 2026-10\nBatch INV-2026-10-7   generated 2026-11-01T08:00:00.000Z\n\n" +
        rule + "\nSeller: Opus Music Kft.  (tax no. 67890123-2-42)\n" + rule + "\n" +
        "Invoice             Order     Customer                Qty           Net         VAT       Gross\n" +
        "TB-202610-000001    TB-00007  Anna Kovács             2           92.13       24.87      117.00\n" +
        dash + "\n" +
        "Total                                                             92.13       24.87      117.00\n" +
        "VAT 27% included in the gross amounts.\n\n" +
        rule + "\nSeller: Somewhere New\n" + rule + "\n" +
        "Invoice             Order     Customer                Qty           Net         VAT       Gross\n" +
        "TB-202610-000002    TB-00009  A very long customer na…1            7.87        2.12        9.99\n" +
        dash + "\n" +
        "Total                                                              7.87        2.12        9.99\n" +
        "VAT 27% included in the gross amounts.\n\n",
    );
  });

  it("prints a customer name that fills the 24-character column in full, and cuts one longer with …", () => {
    const fits = "X".repeat(24);
    const fitsTxt = exportOf([row({ customer_name: fits })]).txt;
    expect(fitsTxt).toContain("TB-00007  " + fits + "2    ");
    const longTxt = exportOf([row({ customer_name: fits + "Y" })]).txt;
    expect(longTxt).toContain("TB-00007  " + "X".repeat(23) + "…2    ");
  });

  it("prints the month as it was asked for", () => {
    expect(exportOf([row()], "2026-3").txt.split("\n")[0]).toBe("TICKETBAY - ORGANIZER INVOICES 2026-3");
  });

  it("right-aligns amounts of any size in 12-character columns", () => {
    const txt = exportOf([row({ tickets_cents: "123456789" })]).txt;
    const line = txt.split("\n").find((l) => l.startsWith("TB-202610"))!;
    expect(line.slice(59)).toBe("   972100.70   262467.19  1234567.89");
  });

  it("pins current behaviour — suspected bug: a newline in a customer name splits the invoice row in two", () => {
    const txt = exportOf([row({ customer_name: "Anna\nKovács" })]).txt;
    expect(txt).toContain("TB-202610-000001    TB-00007  Anna\nKovács             2 ");
  });

  it("pins current behaviour — suspected bug: an amount under €1 is printed one character too far right", () => {
    const txt = exportOf([row({ tickets_cents: "50" })]).txt;
    const line = txt.split("\n").find((l) => l.startsWith("TB-202610"))!;
    // 39 cents net, 11 VAT, 50 gross: each column is 13 characters wide instead of 12
    expect(line.slice(59)).toBe("         0.39         0.11         0.50");
  });
});

describe("the mails", () => {
  it("one per organizer, to the organizer's email, with its count, totals and invoice range", () => {
    const r = exportOf([row({ id: 1, venue: "A38 Ship", tickets_cents: "12700" }), row({ id: 2, venue: "A38 Ship", tickets_cents: "999" }), row({ id: 3, venue: "MVM Dome" })]);
    expect(r.mails).toHaveLength(2);
    expect(r.mails[0]).toEqual({
      to: "finance@danubestage.example",
      subject: "TicketBay invoices 2026-10 (INV-2026-10-1)",
      body:
        "Dear Danube Stage Kft.,\n\nattached are the ticket invoices TicketBay issued in your name for 2026-10.\n\n" +
        "  invoices:  2\n" +
        "  net:             107.87 EUR\n" +
        "  VAT 27%:          29.12 EUR\n" +
        "  gross:           136.99 EUR\n\n" +
        "First invoice: TB-202610-000001, last invoice: TB-202610-000002\n" +
        "\nThanks,\nTicketBay Finance\n",
    });
    expect(r.mails[1].to).toBe("settlements@domearena.example");
  });
});

describe("pinned crashes", () => {
  it("pins current behaviour — suspected bug: a month with no paid orders throws instead of exporting nothing", () => {
    expect(() => exportOf([])).toThrow(TypeError);
  });

  it("pins current behaviour — suspected bug: a €0 order (100% discount) makes the whole export throw", () => {
    expect(() => exportOf([row({ tickets_cents: "0", discount_cents: "13000" })])).toThrow(RangeError);
  });

  it("pins current behaviour — suspected bug: a 1 or 2 cent order makes the whole export throw (its VAT rounds to 0, found by the crash hunt)", () => {
    expect(() => exportOf([row({ tickets_cents: "1" })])).toThrow(RangeError);
    expect(() => exportOf([row({ tickets_cents: "2" })])).toThrow(RangeError);
    expect(() => exportOf([row({ tickets_cents: "3" })])).not.toThrow();
  });

  it("pins current behaviour — suspected bug: a venue named like an Object method (toString, valueOf, …) makes the export throw (found by the crash hunt)", () => {
    for (const venue of ["toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__defineGetter__"]) {
      expect(() => exportOf([row({ venue })]), venue).toThrow(TypeError);
    }
  });

  it("pins current behaviour — suspected bug: a venue named __proto__ or constructor is invoiced to organizer undefined / Object, with no email", () => {
    const proto = exportOf([row({ venue: "__proto__" })]);
    expect(proto.result.organizers[0]).toMatchObject({ organizer: undefined, email: undefined, taxNo: undefined });
    expect(csvLines(proto.csv)[0]).toContain(",undefined,undefined,");
    expect(proto.mails[0].to).toBeUndefined();
    const ctor = exportOf([row({ venue: "constructor" })]);
    expect(ctor.result.organizers[0]).toMatchObject({ organizer: "Object", email: undefined });
  });

  it("pins current behaviour — suspected bug: an order with a 0 subtotal gets discount percent NaN (null in the JSON, NaN in the CSV)", () => {
    const r = exportOf([row({ subtotal_cents: "0", discount_cents: "0" })]);
    expect(r.result.organizers[0].lines[0].discountPercent).toBeNaN();
    expect(csvLines(r.csv)[0].split(",")[9]).toBe("NaN");
  });

  it("pins current behaviour — suspected bug: a month that is not YYYY-MM throws", () => {
    expect(() => exportOf([row()], "abc")).toThrow(RangeError);
    expect(() => exportOf([row()], "2026")).toThrow(RangeError);
  });

  it("pins current behaviour — suspected bug: month 13 silently becomes January of the next year", () => {
    expect(invoiceMonth("2026-13").start).toEqual(new Date("2027-01-01T00:00:00.000Z"));
    expect(exportOf([row()], "2026-13").result.month).toBe("2027-01");
  });
});
