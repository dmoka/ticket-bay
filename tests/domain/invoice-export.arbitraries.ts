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

/** A venue: one on the organizer list, any text, or the name of an Object.prototype member. */
export const venue = fc.oneof(fc.constantFrom(...KNOWN_VENUES), text, fc.constantFrom(...Object.getOwnPropertyNames(Object.prototype)));
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
    tickets_cents: fc.oneof(bigintColumn(0, 200), bigintColumn(0, MAX)),
    // a hundred years either side of 2026
    created_at_ms: bigintColumn(Date.UTC(1926, 0, 1), Date.UTC(2126, 0, 1)),
  });

/** Valid months: YYYY-MM, a year from 1000 to 9999, the month's leading zero optional. */
export const month = fc
  .record({ y: fc.oneof(fc.integer({ min: 1970, max: 2100 }), fc.integer({ min: 1000, max: 9999 })), m: fc.integer({ min: 1, max: 12 }), zero: fc.boolean() })
  .map(({ y, m, zero }) => `${y}-${zero ? String(m).padStart(2, "0") : m}`);

/** Anything a client can send as ?month=: valid months, near misses and junk. */
export const anyMonth = fc.oneof(
  month,
  fc
    .record({ y: fc.integer({ min: -10, max: 200_000 }), m: fc.integer({ min: -1, max: 30 }), tail: fc.constantFrom("", "z", "x", "-15", " ", "-") })
    .map(({ y, m, tail }) => `${y}-${m}${tail}`),
  fc.constantFrom("", "abc", "2026", "2026-", "2026-00", "2026-13", "0099-10", "99-10", "2026-0x", "2026-1e1", "２０２６-10", "2026-10\n"),
  text,
);
