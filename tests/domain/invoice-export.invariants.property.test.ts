// Invariant properties of the invoice export core (src/domain/invoice-export.ts),
// in English:
//  1. Money. On every line net + VAT = gross, gross is the order's tickets_cents,
//     and VAT is 27/127 of gross rounded to the nearest cent (an exact BigInt
//     oracle, not the production formula). Each organizer's totals are the sums of
//     its lines; the export's totals are the sums of the organizers.
//  2. Completeness. Every row is on exactly one line, under the organizer of its
//     venue; the line count is the row count.
//  3. Invoice numbers. One per line, taken in row order from the running counter:
//     together they are one consecutive block, unique, increasing within an
//     organizer, all with the month's prefix.
//  4. CSV round trip. Parsing the CSV back (RFC 4180 quoting) gives one record per
//     line with the line's organizer, customer, event and amounts.
//  5. Printable copy. For amounts from €1 to below €100,000,000 the amount columns
//     line up: every invoice row and total row is 95 characters, ending in three
//     12-character right-aligned amounts.
//  6. Mails. One per organizer, to its email, stating its count and totals.
//
// Orders are capped at 10^13 cents (€100 billion) here: above about 2.5·10^13
// the VAT drifts a cent off the exact value (pinned in invoice-export.test.ts),
// and 15 lines of up to MAX_SAFE_INTEGER would sum past 2^53.
//
// Every run picks a new random seed; FC_SEED=<n> replays a failing run.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildInvoiceExport, type InvoiceOrderRow } from "../../src/domain/invoice-export";
import { invoiceRow, month } from "./invoice-export.arbitraries";

const SEED = Number(process.env.FC_SEED ?? Math.floor(Math.random() * 2 ** 31));
const runs = (numRuns: number) => ({ seed: SEED, numRuns: Number(process.env.FC_RUNS ?? numRuns) });

type Line = { invoiceNo: string; orderId: number; customer: string; eventName: string; netCents: number; vatCents: number; grossCents: number; tickets: number; discountPercent: number };
type Group = { organizer: string; email: string; taxNo: string; lines: Line[]; netCents: number; vatCents: number; grossCents: number };

function run(rows: InvoiceOrderRow[], m: string, firstSeq: number) {
  let seq = firstSeq;
  const out = buildInvoiceExport({ rows, month: m, now: new Date(Date.UTC(2026, 10, 1)), nextInvoiceSeq: () => seq++ });
  return { ...out, groups: out.result.organizers as Group[] };
}

/** 27/127 of gross, rounded half up, in exact integers. */
const vatOracle = (gross: number) => Number((BigInt(gross) * 27n * 2n + 127n) / 254n);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const MAX_ORDER_CENTS = 10_000_000_000_000;
const capped = fc.oneof(fc.integer({ min: 3, max: 2_000_000 }), fc.integer({ min: 3, max: MAX_ORDER_CENTS }));
const cappedRow = fc.tuple(invoiceRow, capped, fc.boolean()).map(([r, cents, asString]) => ({ ...r, tickets_cents: asString ? String(cents) : cents }));
const rowsArb = fc.array(cappedRow, { minLength: 1, maxLength: 15 });
const firstSeq = fc.integer({ min: 1, max: 999_000 });

/** RFC 4180: fields split on commas, records on \n, "…" quoting with "" for a quote. */
function parseCsv(csv: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let rec: string[] = [];
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i]!;
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") rec.push(field), (field = "");
    else if (ch === "\n") rec.push(field), records.push(rec), (rec = []), (field = "");
    else field += ch;
  }
  return records;
}

describe("1. money", () => {
  it("every line: net + VAT = gross = tickets_cents, VAT = 27/127 of gross to the cent", () => {
    fc.assert(
      fc.property(rowsArb, month, (generated, m) => {
        const rows = generated.map((r, i) => ({ ...r, id: i + 1 }));
        for (const g of run(rows, m, 1).groups) {
          for (const l of g.lines) {
            expect(l.grossCents).toBe(Number(rows[l.orderId - 1]!.tickets_cents));
            expect(l.netCents + l.vatCents).toBe(l.grossCents);
            expect(l.vatCents).toBe(vatOracle(l.grossCents));
            expect(l.netCents).toBeGreaterThanOrEqual(0);
          }
        }
      }),
      runs(500),
    );
  });

  it("organizer totals are the sums of their lines, export totals the sums of the organizers", () => {
    fc.assert(
      fc.property(rowsArb, month, (rows, m) => {
        const { groups, result } = run(rows, m, 1);
        for (const g of groups) {
          expect(g.netCents).toBe(sum(g.lines.map((l) => l.netCents)));
          expect(g.vatCents).toBe(sum(g.lines.map((l) => l.vatCents)));
          expect(g.grossCents).toBe(sum(g.lines.map((l) => l.grossCents)));
        }
        expect(result.totals).toEqual({
          invoices: rows.length,
          netCents: sum(groups.map((g) => g.netCents)),
          vatCents: sum(groups.map((g) => g.vatCents)),
          grossCents: sum(groups.map((g) => g.grossCents)),
        });
        expect(result.totals.grossCents).toBe(sum(rows.map((r) => Number(r.tickets_cents))));
      }),
      runs(500),
    );
  });

  it("the discount percent is between 0 and 100 when the discount is at most the subtotal", () => {
    fc.assert(
      fc.property(rowsArb, month, (rows, m) => {
        const fair = rows.filter((r) => Number(r.subtotal_cents) > 0 && Number(r.discount_cents) <= Number(r.subtotal_cents));
        fc.pre(fair.length > 0);
        for (const g of run(fair, m, 1).groups) for (const l of g.lines) expect(l.discountPercent >= 0 && l.discountPercent <= 100).toBe(true);
      }),
      runs(300),
    );
  });
});

describe("2. completeness", () => {
  it("every row is on exactly one line, the lines of an organizer all share its venue's organizer", () => {
    fc.assert(
      fc.property(rowsArb, month, (rows, m) => {
        // ids as the database has them: unique
        const unique = rows.map((r, i) => ({ ...r, id: i + 1 }));
        const { groups } = run(unique, m, 1);
        const ids = groups.flatMap((g) => g.lines.map((l) => l.orderId));
        expect(ids.slice().sort((a, b) => a - b)).toEqual(unique.map((r) => r.id));
        expect(new Set(groups.map((g) => g.organizer)).size).toBe(groups.length);
        for (const r of unique) {
          const g = groups.find((x) => x.lines.some((l) => l.orderId === r.id))!;
          const sameVenue = unique.filter((o) => o.venue === r.venue).map((o) => o.id);
          for (const id of sameVenue) expect(g.lines.some((l) => l.orderId === id)).toBe(true);
        }
      }),
      runs(300),
    );
  });
});

describe("3. invoice numbers", () => {
  it("one consecutive block from the counter, unique, increasing within an organizer, with the month's prefix", () => {
    fc.assert(
      fc.property(rowsArb, month, firstSeq, (rows, m, first) => {
        const { groups, result } = run(rows, m, first);
        const prefix = "TB-" + result.month.replace("-", "") + "-";
        const all = groups.flatMap((g) => g.lines.map((l) => l.invoiceNo));
        for (const no of all) expect(no.startsWith(prefix)).toBe(true);
        const seqs = all.map((no) => Number(no.slice(prefix.length)));
        expect(seqs.slice().sort((a, b) => a - b)).toEqual(rows.map((_, i) => first + i));
        for (const g of groups) {
          const s = g.lines.map((l) => Number(l.invoiceNo.slice(prefix.length)));
          expect(s).toEqual(s.slice().sort((a, b) => a - b));
        }
      }),
      runs(300),
    );
  });
});

describe("4. CSV round trip", () => {
  it("parses back to one record per line, with the line's organizer, customer, event and amounts", () => {
    fc.assert(
      fc.property(rowsArb, month, (rows, m) => {
        const { groups, csv, result } = run(rows, m, 1);
        const [header, ...records] = parseCsv(csv);
        expect(header).toHaveLength(14);
        const lines = groups.flatMap((g) => g.lines.map((l) => ({ g, l })));
        expect(records).toHaveLength(lines.length);
        records.forEach((rec, i) => {
          const { g, l } = lines[i]!;
          expect(rec).toEqual([
            result.batchId,
            l.invoiceNo,
            "TB-" + String(l.orderId).padStart(5, "0"),
            expect.any(String),
            g.organizer,
            g.taxNo,
            l.customer,
            l.eventName,
            String(l.tickets),
            String(l.discountPercent),
            (l.netCents / 100).toFixed(2),
            (l.vatCents / 100).toFixed(2),
            (l.grossCents / 100).toFixed(2),
            "27%",
          ]);
        });
      }),
      runs(500),
    );
  });
});

describe("5. printable copy", () => {
  it("amounts from €1 to below €100,000,000 line up in three 12-character columns", () => {
    // VAT of at least €1 needs gross ≥ 571 cents; gross below €100M keeps every amount within 12 characters
    const printable = cappedRow.map((r) => ({
      ...r,
      tickets_cents: 571 + (Number(r.tickets_cents) % (10_000_000_000 - 571)),
      // a newline in a name breaks the row (pinned in invoice-export.test.ts)
      customer_name: r.customer_name.replace(/[\r\n]/g, " "),
    }));
    fc.assert(
      fc.property(fc.array(printable, { minLength: 1, maxLength: 10 }), month, (rows, m) => {
        const { groups, txt } = run(rows, m, 1);
        const amountRows = txt.split("\n").filter((l) => l.startsWith("TB-") || l.startsWith("Total "));
        expect(amountRows).toHaveLength(rows.length + groups.length);
        for (const line of amountRows) {
          expect(line.length, line).toBe(95);
          expect(line.slice(59), line).toMatch(/^( *\d+\.\d\d){3}$/);
          for (const k of [0, 1, 2]) expect(line.slice(59 + 12 * k, 71 + 12 * k), line).toMatch(/^ *\d+\.\d\d$/);
        }
      }),
      runs(300),
    );
  });
});

describe("6. mails", () => {
  it("one per organizer, to its email, with its invoice count and totals", () => {
    fc.assert(
      fc.property(rowsArb, month, (rows, m) => {
        const { groups, mails } = run(rows, m, 1);
        expect(mails.map((x) => x.to)).toEqual(groups.map((g) => g.email));
        mails.forEach((mail, i) => {
          const g = groups[i]!;
          expect(mail.body).toContain("  invoices:  " + g.lines.length + "\n");
          expect(mail.body).toContain(" " + (g.grossCents / 100).toFixed(2) + " EUR\n");
          expect(mail.body).toContain(" " + (g.vatCents / 100).toFixed(2) + " EUR\n");
          expect(mail.body).toContain(" " + (g.netCents / 100).toFixed(2) + " EUR\n");
          expect(mail.body).toContain("First invoice: " + g.lines[0]!.invoiceNo + ", last invoice: " + g.lines[g.lines.length - 1]!.invoiceNo + "\n");
        });
      }),
      runs(300),
    );
  });
});
