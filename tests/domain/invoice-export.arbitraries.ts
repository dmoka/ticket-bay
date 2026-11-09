// Generators for the invoice export's inputs, shared by the crash hunts
// (tests/domain/invoice-export.crash.property.test.ts and
// tests/http/organizer-invoices.property.test.ts) and the invariant properties.
import fc from "fast-check";
import type { InvoiceOrderRow } from "../../src/domain/invoice-export";

export const KNOWN_VENUES = ["Budapest Park", "Zamárdi Beach", "Hungexpo Hall G", "MVM Dome", "Kisüzem", "A38 Ship", "Opus Jazz Club"];

/** Text a person can type: any unicode, quotes, commas, newlines, long. Postgres text holds no NUL. */
export const text = fc.oneof(
  fc.string({ unit: "grapheme" }),
  fc.string({ unit: fc.constantFrom("a", " ", ",", '"', "\n", "\r", "=", "…", "é", "李", "🎫", "‮") }),
  fc.string({ unit: "grapheme-ascii", maxLength: 500 }),
  fc.constantFrom("", " ", "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"),
).map((s) => s.replaceAll("\u0000", ""));

export const OBJECT_MEMBERS = new Set(Object.getOwnPropertyNames(Object.prototype));
export const venue = fc.oneof(fc.constantFrom(...KNOWN_VENUES), text).filter((v) => !OBJECT_MEMBERS.has(v));
const bigintColumn = (min: number, max: number) => fc.integer({ min, max }).chain((n) => fc.constantFrom<number | string>(n, String(n)));
const MAX = Number.MAX_SAFE_INTEGER;

export const invoiceRow: fc.Arbitrary<InvoiceOrderRow> = fc
  .record({
    id: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
    event_id: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,30}$/),
    event_name: text,
    venue,
    customer_name: text,
    customer_email: text,
    quantity: fc.integer({ min: 1, max: 50 }),
    subtotal_cents: bigintColumn(0, MAX),
    discount_cents: bigintColumn(0, MAX),
    tickets_cents: bigintColumn(3, MAX),
    // a hundred years either side of 2026
    created_at_ms: bigintColumn(Date.UTC(1926, 0, 1), Date.UTC(2126, 0, 1)),
  });

/** Months that parse: any year and month numbers, with or without leading zeros or trailing text. */
export const month = fc.oneof(
  fc.record({ y: fc.integer({ min: 1970, max: 2100 }), m: fc.integer({ min: 1, max: 12 }) }).map(({ y, m }) => `${y}-${String(m).padStart(2, "0")}`),
  fc
    .record({ y: fc.integer({ min: 0, max: 200_000 }), m: fc.integer({ min: 0, max: 30 }), tail: fc.constantFrom("", "z", "-15", " ", "-") })
    .map(({ y, m, tail }) => `${y}-${m}${tail}`),
);
