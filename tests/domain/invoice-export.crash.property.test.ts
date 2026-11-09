// Crash hunt on the invoice export core (src/domain/invoice-export.ts): for any
// paid order rows the database can hold and any month that names a month, the
// export returns — no TypeError, no RangeError.
//
// Left out of the generators, each pinned in invoice-export.test.ts ("pinned crashes"):
//  - no rows at all;
//  - a €0 order (tickets_cents 0), and a 1 or 2 cent one (its VAT rounds to
//    0): any amount of exactly 0 in the printable copy throws;
//  - a month that does not parse to a date ("abc", "2026");
//  - a venue named like a member of Object.prototype ("toString", "__proto__", …).
//
// Every run picks a new random seed; FC_SEED=<n> replays a failing run.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildInvoiceExport } from "../../src/domain/invoice-export";
import { invoiceRow, month } from "./invoice-export.arbitraries";

const SEED = Number(process.env.FC_SEED ?? Math.floor(Math.random() * 2 ** 31));
const runs = (numRuns: number) => ({ seed: SEED, numRuns });

describe("crash hunt: buildInvoiceExport", () => {
  it("returns an export for any rows and any month that names a month", () => {
    fc.assert(
      fc.property(fc.array(invoiceRow, { minLength: 1, maxLength: 12 }), month, (rows, m) => {
        let seq = 1;
        const out = buildInvoiceExport({ rows, month: m, now: new Date(Date.UTC(2026, 10, 1)), nextInvoiceSeq: () => seq++ });
        expect(typeof out.csv).toBe("string");
        expect(typeof out.txt).toBe("string");
        JSON.stringify(out.result);
      }),
      runs(Number(process.env.FC_RUNS ?? 300)),
    );
  });
});
