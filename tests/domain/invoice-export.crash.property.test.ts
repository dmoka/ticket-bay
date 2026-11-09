// Crash hunt on the invoice export core (src/domain/invoice-export.ts): for any
// paid order rows the database can hold (none at all, €0 orders and venues
// named like Object.prototype members included) and anything as the month, the
// export returns — or, for a month that is not YYYY-MM, throws the documented
// RangeError. No TypeError, no other RangeError.
//
// Every run picks a new random seed; FC_SEED=<n> replays a failing run.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildInvoiceExport } from "../../src/domain/invoice-export";
import { anyMonth, invoiceRow, month } from "./invoice-export.arbitraries";

const SEED = Number(process.env.FC_SEED ?? Math.floor(Math.random() * 2 ** 31));
const runs = (numRuns: number) => ({ seed: SEED, numRuns });

const exportOf = (rows: Parameters<typeof buildInvoiceExport>[0]["rows"], m: string) => {
  let seq = 1;
  return buildInvoiceExport({ rows, month: m, now: new Date(Date.UTC(2026, 10, 1)), nextInvoiceSeq: () => seq++ });
};

describe("crash hunt: buildInvoiceExport", () => {
  it("returns an export for any rows and any month, or refuses the month with the documented RangeError", () => {
    fc.assert(
      fc.property(fc.array(invoiceRow, { maxLength: 12 }), anyMonth, (rows, m) => {
        let out;
        try {
          out = exportOf(rows, m);
        } catch (e) {
          expect(e).toEqual(new RangeError("month must be YYYY-MM, e.g. 2026-10"));
          return;
        }
        expect(typeof out.csv).toBe("string");
        expect(typeof out.txt).toBe("string");
        JSON.stringify(out.result);
      }),
      runs(Number(process.env.FC_RUNS ?? 300)),
    );
  });

  it("never refuses a valid month", () => {
    fc.assert(
      fc.property(fc.array(invoiceRow, { maxLength: 12 }), month, (rows, m) => {
        expect(() => exportOf(rows, m)).not.toThrow();
      }),
      runs(Number(process.env.FC_RUNS ?? 300)),
    );
  });
});
