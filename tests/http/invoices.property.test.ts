// Crash hunt for GET /api/v1/organizer/invoices (legacy-testing, step 4), at
// the HTTP level: generated Requests into the real route handler, real Better
// Auth keys, real Postgres (Testcontainers).
//
// The property, in English: for ANY request to the endpoint — any ?month (a
// real month, a lenient spelling, a month out of range, garbage), any ?event
// (an event with orders, one without, an unknown id, a malformed one), junk
// or repeated parameters, bad percent-escapes, any API key or none, any
// request clock, any method — the status is below 500 and the body is JSON;
// an error is {"error": "..."} with no stack trace and no SQL in it.
//
// The data state is one world with every case in it: a venue with January
// orders (odd customer names among them), one with February orders, one with
// refunded orders only, one with no orders, and months with nothing.
//
// The seed is fixed so a failure replays exactly; FC_SEED=<n> explores another
// stream. A crash the hunt finds is pinned in invoices.test.ts and its input
// class is taken out of the generator here, with the pin's name, until it is
// fixed.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import type { Auth } from "../../src/auth/auth";
import { orders } from "../../src/db/schema";
import { createFakeStripe } from "../../src/payments";
import { customer, makeAuth, revokeKey, scopedKey, useCleanAccounts, type Customer } from "../integration/accounts";
import { useTestDatabase } from "../integration/database";
import { DAY, NOW, venue } from "../integration/fixtures";
import { call, loadRoutes, quietRefusedKeyLogs, type Call, type Reply } from "./client";

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

const SEED = Number(process.env.FC_SEED ?? 20261008);
const runs = (numRuns: number) => ({ seed: SEED, numRuns });

let auth: Auth;

beforeAll(async () => {
  process.env.TICKETBAY_TEST_CLOCK = "1";
  auth = makeAuth(t.db);
  wiring.auth = auth;
  wiring.db = t.db;
  wiring.payments = createFakeStripe("sk_test_property");
  await loadRoutes();
});

afterAll(() => {
  delete process.env.TICKETBAY_TEST_CLOCK;
});

/** A fresh key: Better Auth rate-limits each key to 120 requests a minute. */
const freshKey = async (c: Customer) => (await scopedKey(auth, c.id, "read-write")).key;

/** A value whose counterexample prints as `text`. */
const shown = <T extends object>(value: T, text: string): T => Object.assign(value, { [fc.toStringMethod]: () => text });

// ---- The world --------------------------------------------------------------------

const JAN = Date.UTC(2027, 0, 1);
const FEB = Date.UTC(2027, 1, 1);

let n = 0;
async function order(eventId: string, over: Partial<typeof orders.$inferInsert> = {}) {
  await t.db.insert(orders).values({
    eventId,
    customerEmail: `fan${++n}@example.com`,
    customerName: "A Fan",
    quantity: 1,
    subtotalCents: 10_000,
    discountPercent: 0,
    discountCents: 0,
    ticketsCents: 10_000,
    feeCents: 300,
    totalCents: 10_300,
    vatCents: 2_189,
    paymentId: `ch_${n}`,
    idempotencyKey: `hunt-${n}`,
    createdAtMs: NOW,
    ...over,
  });
}

interface World {
  anna: Customer;
  readOnlyKey: string;
  revokedKey: string;
}

async function world(): Promise<World> {
  await venue(t.db, { id: "park", venue: "Budapest Park", name: "Park Night" });
  await venue(t.db, { id: "beach", venue: "Zamárdi Beach", name: "Beach Fest, day 2" });
  await venue(t.db, { id: "refunds", venue: "Arena", name: "Refunded Show" });
  await venue(t.db, { id: "empty", venue: 'Nowhere, "Else"', name: "Never Sold" });
  // January 2027: the park, with the odd names and the amounts in it
  await order("park");
  await order("park", { customerName: 'Kovács, "Jr." Ádám\n(VIP)', createdAtMs: JAN });
  await order("park", { customerName: "Dr. Nagy-Kovács Erzsébet Mária", quantity: 5, subtotalCents: 25_000, discountPercent: 5, discountCents: 1_250, ticketsCents: 23_750, feeCents: 713, totalCents: 24_463, createdAtMs: FEB - 1 });
  await order("park", { customerName: "", subtotalCents: 50, ticketsCents: 50, feeCents: 100, totalCents: 150 });
  // A free order (100% discount) is left out until the pinned crash is fixed:
  // invoices.test.ts "suspected bug: a free order in the month is a 500".
  // February 2027: the beach
  await order("beach", { createdAtMs: FEB + DAY });
  // refunded only
  await order("refunds", { status: "refunded", refundedAtMs: NOW + DAY, refundCents: 9_800, refundFeeCents: 200, refundReason: "customer" });

  const anna = await customer(auth, "Anna");
  const readOnlyKey = (await scopedKey(auth, anna.id, "read")).key;
  const gone = await customer(auth, "Gone");
  await revokeKey(auth, gone);
  return { anna, readOnlyKey, revokedKey: gone.key };
}

// ---- The requests -----------------------------------------------------------------

/** One character: printable ASCII, an ASCII control character (NUL included), or any code point. */
const anyChar = fc.oneof(
  { withCrossShrink: true },
  { weight: 3, arbitrary: fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 1 }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 0x1f }).map((c) => String.fromCharCode(c)) },
  { weight: 1, arbitrary: fc.string({ unit: "binary", minLength: 1, maxLength: 1 }) },
);
const anyString = fc.oneof({ withCrossShrink: true }, fc.string({ unit: anyChar }), fc.string({ unit: "grapheme" }), fc.string({ unit: anyChar, maxLength: 3000, size: "max" }));

/** Months: real ones in the spellings the route takes, out-of-range ones, other spellings, garbage. */
const year = fc.oneof({ weight: 4, arbitrary: fc.constant("2027") }, fc.constantFrom("2026", "2028", "0000", "0001", "1969", "1970", "2999", "3000", "9999", "99999", "275760", "275761", "-2027", "2027.5", "１２３４"), fc.string({ maxLength: 6 }));
const mon = fc.oneof({ weight: 4, arbitrary: fc.constantFrom("01", "02", "03") }, fc.integer({ min: 1, max: 12 }).map(String), fc.constantFrom("00", "13", "99", "1", "2", "3", "-1", "1.5", "0x1", " 1", "1 ", ""), fc.string({ maxLength: 3 }));
const month = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom("2027-01", "2027-1", "2027-02", "2027-03") },
  { weight: 2, arbitrary: fc.tuple(year, mon).map(([y, m]) => `${y}-${m}`) },
  fc.constantFrom("2027-01-15", "2027/01", "202701", "2027-Jan", "banana", "", " ", "2027-01\n", "null", "undefined", "2027-01-15", "-2027-01", "2027-1.5"),
  anyString,
);

/** Events: with January orders, with February orders, with refunded orders only, with none, unknown, malformed, or anything. */
const event = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom("park", "beach", "refunds", "empty", "no-such-event") },
  fc.constantFrom("NOT AN ID", "", "park/../beach", "Park", "a".repeat(101), "-park"),
  anyString,
);

/** Junk the query may also carry. */
const junk = fc.oneof(fc.constant(""), fc.constantFrom("&", "&=", "&x=1", "&month[]=2027-01", "&from=2027-01-01&to=2027-02-01", "&event", "&organizer=Budapest%20Park"), anyString.map((s) => `&${encodeURIComponent(s)}=${encodeURIComponent(s)}`));

/** Percent signs that do not decode: a client can put them in a query as is. */
const badEscape = fc.constantFrom("%", "%Z", "%ZZ", "%E0%A4%A", "%C0", "%FF%FE");

type Who = "own key" | "read-only key" | "revoked key" | { authorization: string };
const who: fc.Arbitrary<Who | undefined> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<Who>("own key") },
  fc.constantFrom<Who>("read-only key", "revoked key"),
  fc.constant(undefined),
  fc.string().map((raw) => ({ authorization: raw })),
  fc.string().map((token) => ({ authorization: `Bearer tb_${token}` })),
);

const clock = fc.oneof(
  { withCrossShrink: true },
  { weight: 3, arbitrary: fc.constant(NOW) },
  { weight: 1, arbitrary: fc.integer({ min: NOW - 730 * DAY, max: NOW + 730 * DAY }) },
  { weight: 1, arbitrary: fc.constant("not-a-time") },
);

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;
const method = fc.oneof({ weight: 6, arbitrary: fc.constant<(typeof METHODS)[number]>("GET") }, fc.constantFrom(...METHODS));

interface ApiRequest {
  method: (typeof METHODS)[number];
  /** the query string, "?" included, or "" */
  query: string;
  who?: Who;
  clock: number | string;
}

const query: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ month: fc.option(month, { nil: undefined }), event: fc.option(event, { nil: undefined }), junk }).map(({ month, event, junk }) => {
    const p = new URLSearchParams();
    if (month !== undefined) p.set("month", month);
    if (event !== undefined) p.set("event", event);
    const q = p.toString() + junk;
    return q ? `?${q.replace(/^&/, "")}` : "";
  }) },
  { weight: 1, arbitrary: fc.tuple(fc.constantFrom("?month=", "?event=", "?month=2027-01&event=", "?"), badEscape).map(([k, bad]) => `${k}${bad}`) },
  { weight: 1, arbitrary: fc.constantFrom("?month=2027-01&month=banana", "?event=park&event=NOT%20AN%20ID", "?month=2027-01&event=park&event=", "?#", "??month=2027-01") },
);

function describeRequest(r: ApiRequest): string {
  const parts = [`${r.method} /api/v1/organizer/invoices${r.query}`];
  if (r.who !== undefined) parts.push(typeof r.who === "string" ? `[${r.who}]` : `[authorization: ${JSON.stringify(r.who.authorization)}]`);
  else parts.push("[no key]");
  if (r.clock !== NOW) parts.push(`[now: ${typeof r.clock === "number" ? new Date(r.clock).toISOString() : JSON.stringify(r.clock)}]`);
  return parts.join("  ");
}

const apiRequest: fc.Arbitrary<ApiRequest> = fc
  .record({ method, query, who, clock })
  .map((r) => shown(r, describeRequest(r)));

async function toCall(w: World, r: ApiRequest): Promise<Call> {
  const headers: Record<string, string> = {};
  if (r.who === "own key") headers.authorization = `Bearer ${await freshKey(w.anna)}`;
  else if (r.who === "read-only key") headers.authorization = `Bearer ${w.readOnlyKey}`;
  else if (r.who === "revoked key") headers.authorization = `Bearer ${w.revokedKey}`;
  else if (r.who !== undefined) headers.authorization = r.who.authorization;
  if (typeof r.clock === "string") headers.cookie = `tb-test-now=${r.clock}`;
  return { method: r.method, path: `/api/v1/organizer/invoices${r.query}`, headers, nowMs: typeof r.clock === "number" ? r.clock : undefined };
}

/** Below 500, and JSON — errors as {"error": "..."} a person can read, with nothing internal in it. HEAD has no body. */
function expectRobust(r: Reply, method: string) {
  expect(r.status, `${r.status} ${r.text}`).toBeLessThan(500);
  if (method === "HEAD") return;
  expect(r.isJson, `${r.status}, not JSON: ${JSON.stringify(r.text)}`).toBe(true);
  expect(r.headers.get("content-type")).toMatch(/^application\/json/);
  if (r.status >= 400) {
    expect(r.body, r.text).toEqual({ error: expect.any(String) });
    expect(r.body.error).not.toMatch(/\n\s+at |Failed query|postgres|drizzle|TypeError|RangeError/i);
  } else if (method === "GET") {
    expect(r.body, r.text).toMatchObject({ batchId: expect.any(String), month: expect.stringMatching(/^\d{4}-\d{2}$/), organizers: expect.any(Array), totals: expect.any(Object) });
  } else {
    expect(r.body, r.text).toEqual({ allow: ["GET", "OPTIONS"] }); // OPTIONS
  }
}

describe("crash hunt: GET /api/v1/organizer/invoices", () => {
  it("any request gets a status below 500 and a JSON body", async () => {
    const w = await world();
    await fc.assert(
      fc.asyncProperty(apiRequest, async (r) => {
        expectRobust(await call(await toCall(w, r)), r.method);
      }),
      runs(Number(process.env.HUNT_RUNS ?? 300)),
    );
  }, 120_000);
});
