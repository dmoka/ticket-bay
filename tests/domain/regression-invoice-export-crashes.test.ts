// Regression tests for the invoice export core (src/domain/invoice-export.ts):
// the inputs that used to make the export throw, found by the characterization
// tests and the crash-hunt properties of the legacy-testing rescue.
import { describe, it, expect } from "vitest";
import { buildInvoiceExport, invoiceMonth, isInvoiceMonth, type InvoiceOrderRow } from "../../src/domain/invoice-export";

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
    created_at_ms: String(Date.UTC(2026, 9, 3)),
    ...over,
  };
}

function exportOf(rows: InvoiceOrderRow[], month = "2026-10") {
  let seq = 1;
  return buildInvoiceExport({ rows, month, now: NOW, nextInvoiceSeq: () => seq++ });
}

const amountsOf = (txt: string) => txt.split("\n").find((l) => l.startsWith("TB-202610"))!.slice(59);

describe("a month with no paid orders", () => {
  it("is an empty export: no organizers, zero totals, a header-only CSV, no mails", () => {
    const r = exportOf([]);
    expect(r.result).toMatchObject({
      batchId: "INV-2026-10-0",
      month: "2026-10",
      organizers: [],
      totals: { invoices: 0, netCents: 0, vatCents: 0, grossCents: 0 },
    });
    expect(r.csv).toBe("batch_id,invoice_no,order_no,date,organizer,organizer_tax_no,customer,event,tickets,discount_pct,net_eur,vat_eur,gross_eur,vat_rate\n");
    expect(r.txt).toBe("TICKETBAY - ORGANIZER INVOICES 2026-10\nBatch INV-2026-10-0   generated 2026-11-01T08:00:00.000Z\n\n");
    expect(r.mails).toEqual([]);
  });
});

describe("small amounts", () => {
  it("a €0 order (100% discount) is invoiced at 0.00", () => {
    const r = exportOf([row({ tickets_cents: "0", discount_cents: "13000" })]);
    expect(r.result.organizers[0]!.lines[0]).toMatchObject({ grossCents: 0, vatCents: 0, netCents: 0, discountPercent: 100 });
    expect(amountsOf(r.txt)).toBe("        0.00        0.00        0.00");
    expect(r.mails[0]!.body).toContain("  gross:             0.00 EUR\n");
  });

  it("a 1 or 2 cent order, whose VAT rounds to 0, is invoiced", () => {
    expect(amountsOf(exportOf([row({ tickets_cents: "1" })]).txt)).toBe("        0.01        0.00        0.01");
    expect(amountsOf(exportOf([row({ tickets_cents: "2" })]).txt)).toBe("        0.02        0.00        0.02");
  });

  it("amounts under €1 line up with the others in their 12-character columns", () => {
    expect(amountsOf(exportOf([row({ tickets_cents: "50" })]).txt)).toBe("        0.39        0.11        0.50");
  });
});

describe("venue names", () => {
  it("a venue named like an Object method is its own organizer, like any venue not on the list", () => {
    for (const venue of ["toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "__defineGetter__", "__proto__", "constructor"]) {
      const r = exportOf([row({ venue })]);
      expect(r.result.organizers, venue).toEqual([expect.objectContaining({ organizer: venue, email: "invoices@ticketbay.example", taxNo: "" })]);
      expect(r.mails[0]!.to, venue).toBe("invoices@ticketbay.example");
    }
  });

  it("two such venues stay two organizers, each with its own lines", () => {
    const r = exportOf([row({ id: 1, venue: "toString" }), row({ id: 2, venue: "__proto__" }), row({ id: 3, venue: "toString" })]);
    expect(r.result.organizers.map((g) => [g.organizer, g.lines.map((l) => l.orderId)])).toEqual([
      ["toString", [1, 3]],
      ["__proto__", [2]],
    ]);
  });
});

describe("the month", () => {
  it("is YYYY-MM, the leading zero of the month optional", () => {
    for (const m of ["2026-10", "2026-01", "2026-1", "1970-12", "9999-12"]) expect(isInvoiceMonth(m), m).toBe(true);
  });

  it("anything else is not a month", () => {
    for (const m of ["", "abc", "2026", "2026-", "2026-0", "2026-00", "2026-13", "2026-xx", "0099-10", "99-10", "26-10", "20260-1", "2026-10x", "2026-10-01", " 2026-10", "-1-10"]) {
      expect(isInvoiceMonth(m), m).toBe(false);
    }
  });

  it("the export refuses a month that is not YYYY-MM with a RangeError saying so", () => {
    for (const m of ["abc", "2026", "2026-13", "0099-10"]) {
      expect(() => invoiceMonth(m), m).toThrow(new RangeError("month must be YYYY-MM, e.g. 2026-10"));
      expect(() => exportOf([row()], m), m).toThrow(new RangeError("month must be YYYY-MM, e.g. 2026-10"));
    }
  });
});
