// Property tests for the REST API (app/api/v1), at the HTTP level: generated
// Requests routed to the real route handlers (client.ts), real Better Auth
// API keys, real services, real Postgres (Testcontainers).
//
// Properties, in English:
//  1. Robustness. For ANY request under /api/v1 — any method, a known or a
//     random path, any Content-Type and Accept, a valid, boundary or garbage
//     body (wrong types, missing fields, huge / negative / zero / fractional
//     numbers, long and unicode strings, control characters, bad JSON), any
//     Authorization header or none, even a path that is not valid
//     percent-encoding — the status is below 500 and the body is JSON. Errors (404 and 405 included) are {"error": "..."} with no stack
//     trace and no SQL in them.
//  2. Valid input → success. For every VALID order — an event with seats,
//     1-50 tickets, a working code or none, booked at any instant before the
//     start — the API answers 201 with the right order. The clocks lean on the
//     hard places: the early-bird boundary at exactly 30 days, and windows that
//     cross a daylight-saving change in Europe/Budapest. The early-bird the
//     order got matches the end the API itself publishes (earlyBirdEndsAt).
//  3. Oracle. A quote equals a simple model written here, not the production
//     code: ticket price × count, minus the summed discounts capped at 100%,
//     rounded once, plus the 3% fee kept between €1 and €20.
//  4. Stateful. Random interleaved actions by three API users — quote, order
//     (reusing an Idempotency-Key or not, once or twice at the same moment),
//     cancel their own order, try to cancel someone else's — while the clock
//     moves past the event starts. After EVERY step: seats sold never exceed
//     capacity and match the orders holding them; no order gets back more than
//     it paid for its tickets; a refund at or after the start is 0; the money
//     at the payment provider (charges − refunds) equals what the live orders
//     hold (totals − refunds); a reused Idempotency-Key never makes a second
//     order. A failing sequence shrinks to its fewest steps.
//
// The seed is fixed so a failure replays exactly; fast-check prints it with
// the shrunk counterexample. FC_SEED=<n> explores a different stream.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fc from "fast-check";
import { like } from "drizzle-orm";
import type { Auth } from "../../src/auth/auth";
import { events, orders } from "../../src/db/schema";
import { createFakeStripe, type PaymentProvider } from "../../src/payments";
import { customer, makeAuth, revokeKey, scopedKey, useCleanAccounts, type Customer } from "../integration/accounts";
import { useTestDatabase } from "../integration/database";
import { addCode, DAY, HOUR, NOW, venue } from "../integration/fixtures";
import { bearer, call, loadRoutes, type Call, type Reply } from "./client";

// TicketBay sells in Budapest, and its server's clock zone is Europe/Budapest.
// CI runs in UTC, where a date computed with the server's local calendar can
// never cross a daylight-saving change — pin the zone so this file sees what
// production sees.
process.env.TZ = "Europe/Budapest";

const wiring = vi.hoisted(() => ({ auth: undefined as unknown, db: undefined as unknown, payments: undefined as unknown }));
vi.mock("@/lib/auth", () => ({ appBaseURL: () => "http://localhost:3000", getAuth: () => wiring.auth }));
vi.mock("@/src/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/db/client")>()),
  getDb: () => wiring.db,
}));
vi.mock("@/src/payments", async () => ({ ...(await import("../../src/payments")), getPayments: () => wiring.payments }));

const t = useTestDatabase();
useCleanAccounts(t);

const SEED = Number(process.env.FC_SEED ?? 20261004);
const runs = (numRuns: number) => ({ seed: SEED, numRuns });

/**
 * The fake payment provider, fresh for every test like the database: order
 * ids restart with the database, and a refund's idempotency key is
 * `refund-<order id>` — a provider that outlived the database would answer a
 * new order's refund with an old one. It records every charge, so property 4
 * can add up the money at the provider.
 */
const charged = new Set<string>();
let provider = createFakeStripe("sk_test_property");
const payments: PaymentProvider = {
  async charge(input) {
    const c = await provider.charge(input);
    charged.add(c.id);
    return c;
  },
  refund: (...args) => provider.refund(...args),
  getCharge: (id) => provider.getCharge(id),
};
beforeEach(() => {
  provider = createFakeStripe("sk_test_property");
  charged.clear();
});

let auth: Auth;

beforeAll(async () => {
  process.env.TICKETBAY_TEST_CLOCK = "1";
  auth = makeAuth(t.db);
  wiring.auth = auth;
  wiring.db = t.db;
  wiring.payments = payments;
  await loadRoutes();
});

afterAll(() => {
  delete process.env.TICKETBAY_TEST_CLOCK;
});

/** A fresh read & write key: Better Auth rate-limits each key to 120 requests a minute. */
const freshKey = async (c: Customer) => (await scopedKey(auth, c.id, "read-write")).key;

let ids = 0;
const uniqueId = (prefix: string) => `${prefix}-${++ids}`;

/** A value whose counterexample prints as `text` instead of as an object. */
const shown = <T extends object>(value: T, text: string): T => Object.assign(value, { [fc.toStringMethod]: () => text });

// ---- Budapest wall clock (EU rule, written here — not Intl, not the app) -------

const MIN = 60_000;
/** 01:00 UTC on the last Sunday of the month: when EU clocks change. */
function lastSundayOneUtc(year: number, month0: number): number {
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0));
  return Date.UTC(year, month0, lastDay.getUTCDate() - lastDay.getUTCDay(), 1);
}
const isSummer = (ms: number) => {
  const y = new Date(ms).getUTCFullYear();
  return ms >= lastSundayOneUtc(y, 2) && ms < lastSundayOneUtc(y, 9);
};
/** "2026-03-11 19:01 CET" */
function budapest(ms: number): string {
  const summer = isSummer(ms);
  return `${new Date(ms + (summer ? 2 : 1) * HOUR).toISOString().slice(0, 16).replace("T", " ")} ${summer ? "CEST" : "CET"}`;
}
/** The DST changes the generators aim at: spring forward and fall back, 2026-2028. */
const DST_CHANGES = [2026, 2027, 2028].flatMap((y) => [lastSundayOneUtc(y, 2), lastSundayOneUtc(y, 9)]);

// ---- The price model (property 2 and 3's oracle) ------------------------------

/** n / d rounded half up, in integers. */
const roundHalfUp = (n: number, d: number) => Math.floor((2 * n + d) / (2 * d));
const EARLY_BIRD_MS = 30 * 24 * HOUR;

/** What a cart costs, from the help pages: help/early-bird-and-discounts.md and help/booking-and-fees.md. */
function modelPrice(p: { priceCents: number; tickets: number; earlyBird: boolean; codePercent: number }) {
  const subtotalCents = p.priceCents * p.tickets;
  const groupPercent = p.tickets >= 10 ? 10 : p.tickets >= 5 ? 5 : 0;
  const earlyBirdPercent = p.earlyBird ? 10 : 0;
  const discountPercent = Math.min(100, groupPercent + earlyBirdPercent + p.codePercent);
  const discountCents = roundHalfUp(subtotalCents * discountPercent, 100);
  const ticketsCents = subtotalCents - discountCents;
  const feeCents = Math.min(2000, Math.max(100, roundHalfUp(ticketsCents * 3, 100)));
  const totalCents = ticketsCents + feeCents;
  return {
    subtotalCents,
    groupPercent,
    earlyBirdPercent,
    codePercent: p.codePercent,
    discountPercent,
    discountCents,
    ticketsCents,
    feeCents,
    totalCents,
    vatCents: roundHalfUp(totalCents * 27, 127),
  };
}

/** The refund for a whole order cancelled before the start: tickets paid minus 2% (at least 50 cents, at most all of it). */
function modelRefund(ticketsCents: number) {
  const fee = ticketsCents <= 0 ? 0 : Math.min(ticketsCents, Math.max(50, roundHalfUp(ticketsCents * 2, 100)));
  return { refundCents: ticketsCents - fee, refundFeeCents: fee };
}

// ---- 1. Robustness --------------------------------------------------------------

// withCrossShrink: a failing value may shrink into an earlier, simpler branch,
// so a counterexample ends as short and plain as the bug allows.

/** One character: printable ASCII, an ASCII control character (NUL included), or any code point. */
const anyChar = fc.oneof(
  { withCrossShrink: true },
  { weight: 3, arbitrary: fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 1 }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 0x1f }).map((c) => String.fromCharCode(c)) },
  { weight: 1, arbitrary: fc.string({ unit: "binary", minLength: 1, maxLength: 1 }) },
);

/** Strings a client can send: any of those characters, emoji and combining marks, long ones. */
const anyString = fc.oneof(
  { withCrossShrink: true },
  fc.string({ unit: anyChar }),
  fc.string({ unit: "grapheme" }),
  fc.string({ unit: anyChar, maxLength: 3000, size: "max" }),
);

/** What a client can put where a number belongs. JSON turns NaN and ±Infinity into null. */
const anyNumberish = fc.oneof(
  { withCrossShrink: true },
  fc.integer({ min: -100, max: 100 }),
  fc.constantFrom(0, -0, 1, 50, 51, -1, 0.5, 1.5, 2 ** 31, 2 ** 53, 2 ** 53 + 2, 1e308, -1e308, 5e-324),
  fc.double(),
  anyString,
  fc.boolean(),
  fc.constant(null),
);

const EVENT_IDS = ["on-sale", "early-bird", "sold-out", "started", "cancelled"];
const CODES = ["WELCOME10", "welcome10", " WELCOME10 ", "EXPIRED", "USEDUP", ""];

/** Ticket counts: mostly in range, so a body gets past validation and reaches the services. */
const tickets = fc.oneof({ weight: 3, arbitrary: fc.integer({ min: 1, max: 50 }) }, { weight: 2, arbitrary: anyNumberish });
const eventId = fc.oneof({ weight: 1, arbitrary: fc.constantFrom(...EVENT_IDS, "no-such-event") }, { weight: 1, arbitrary: anyString });
const code = fc.oneof(fc.constantFrom(...CODES), anyString, anyNumberish);

type Body = { json: unknown } | { raw: string };

/** A body: a cart (some fields missing or wrong), any JSON value, or any text. */
const body: fc.Arbitrary<Body> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ eventId, tickets, code }, { requiredKeys: ["eventId", "tickets"] }).map((json) => ({ json })) },
  { weight: 2, arbitrary: fc.record({ eventId, tickets, code }, { requiredKeys: [] }).map((json) => ({ json })) },
  { weight: 1, arbitrary: fc.jsonValue({ maxDepth: 3 }).map((json) => ({ json })) },
  { weight: 1, arbitrary: anyString.map((raw) => ({ raw })) },
);

/** Who is calling. Symbolic, so a counterexample reads well; turned into a header per run. */
type Who = "own key" | "other customer's key" | "read-only key" | "revoked key" | { authorization: string };
const who: fc.Arbitrary<Who> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<Who>("own key") },
  fc.constantFrom<Who>("other customer's key", "read-only key", "revoked key"),
  fc.string().map((raw) => ({ authorization: raw })),
  fc.string().map((token) => ({ authorization: `Bearer tb_${token}` })),
);

/** A path segment, as a client percent-encodes it. Never "", "." or "..": a URL normalizes those away before any route runs. */
const segment = anyString.filter((s) => s !== "" && s !== "." && s !== "..");
const enc = (s: string) => encodeURIComponent(s);

const eventPath = fc.oneof(fc.constantFrom(...EVENT_IDS), segment).map((id) => `/events/${enc(id)}`);
const cancelPath = fc
  .oneof(fc.constantFrom("1", "2", "3", "0", "-1", "1.5", "2147483648", "99999999999"), fc.integer().map(String), segment)
  .map((id) => `/orders/${enc(id)}/cancel`);

/** Percent signs that do not decode: a client (or an attacker) can put them in a URL as is. */
const badEscape = fc.constantFrom("%", "%Z", "%ZZ", "%E0%A4%A", "%C0", "%FF%FE");

/** The known endpoints with any id in them, or a random path under /api/v1 — some not even valid percent-encoding. */
const path = fc.oneof(
  fc.constantFrom("/events", "/quote", "/orders"),
  eventPath,
  cancelPath,
  fc.array(segment, { maxLength: 4 }).map((s) => s.map(enc).join("/")).map((p) => (p ? `/${p}` : "")),
  fc.tuple(fc.constantFrom("/events/", "/orders/", "/"), badEscape).map(([prefix, bad]) => `${prefix}${bad}`),
);

const contentType = fc.oneof(
  fc.constantFrom("application/json", "text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/json; charset=utf-16", ""),
  fc.string(),
);
const accept = fc.oneof(fc.constantFrom("application/json", "*/*", "text/html", "application/xml", ""), fc.string());

/** Idempotency-Key header values. Printable only: a Request refuses control characters in headers. */
const idempotencyKey = fc.oneof(fc.string({ maxLength: 120 }), fc.uuid(), fc.string({ minLength: 95, maxLength: 130 }));

/** "now" for the request: mostly NOW, sometimes elsewhere in the year around it, sometimes a junk cookie. */
const clock = fc.oneof(
  { withCrossShrink: true },
  { weight: 3, arbitrary: fc.constant(NOW) },
  { weight: 1, arbitrary: fc.integer({ min: NOW - 365 * DAY, max: NOW + 365 * DAY }) },
  { weight: 1, arbitrary: fc.constant("not-a-time") },
);

interface ApiRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  path: string;
  body?: Body;
  who?: Who;
  idempotencyKey?: string;
  contentType?: string;
  accept?: string;
  clock: number | string;
}

/** `POST /api/v1/quote  {"eventId":"\u0000","tickets":1}` — a request as a person would write it down. */
function describeRequest(r: ApiRequest): string {
  const parts = [`${r.method} /api/v1${r.path}`];
  if (r.who !== undefined) parts.push(typeof r.who === "string" ? `[${r.who}]` : `[authorization: ${JSON.stringify(r.who.authorization)}]`);
  if (r.idempotencyKey !== undefined) parts.push(`[idempotency-key: ${JSON.stringify(r.idempotencyKey)}]`);
  if (r.contentType !== undefined) parts.push(`[content-type: ${JSON.stringify(r.contentType)}]`);
  if (r.accept !== undefined) parts.push(`[accept: ${JSON.stringify(r.accept)}]`);
  if (r.clock !== NOW) parts.push(`[now: ${typeof r.clock === "number" ? new Date(r.clock).toISOString() : JSON.stringify(r.clock)}]`);
  if (r.body) parts.push("json" in r.body ? fc.stringify(r.body.json) : `raw ${fc.stringify(r.body.raw)}`);
  return parts.join("  ");
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** The parts every request may carry; which of them a request has is generated too. */
const extras = { body, who, idempotencyKey, contentType, accept };

/**
 * A request: mostly the method an endpoint answers, on that endpoint, so the
 * body and the key reach the services; the rest any method on any path.
 */
const apiRequest: fc.Arbitrary<ApiRequest> = fc
  .oneof(
    { weight: 1, arbitrary: fc.record({ method: fc.constant("GET" as const), path: fc.oneof(fc.constant("/events"), eventPath), clock, ...extras }, { requiredKeys: ["method", "path", "clock"] }) },
    { weight: 2, arbitrary: fc.record({ method: fc.constant("POST" as const), path: fc.constant("/quote"), clock, ...extras }, { requiredKeys: ["method", "path", "clock", "body"] }) },
    { weight: 2, arbitrary: fc.record({ method: fc.constant("POST" as const), path: fc.constant("/orders"), clock, ...extras }, { requiredKeys: ["method", "path", "clock", "body", "who"] }) },
    { weight: 1, arbitrary: fc.record({ method: fc.constant("POST" as const), path: cancelPath, clock, ...extras }, { requiredKeys: ["method", "path", "clock", "who"] }) },
    { weight: 2, arbitrary: fc.record({ method: fc.constantFrom(...METHODS), path, clock, ...extras }, { requiredKeys: ["method", "path", "clock"] }) },
  )
  // A GET cannot carry a body (fetch refuses to build one).
  .map((r) => (r.method === "GET" ? { ...r, body: undefined } : r))
  .map((r) => shown(r, describeRequest(r)));

interface World {
  anna: Customer;
  bela: Customer;
  readOnlyKey: string;
  revokedKey: string;
}

/** Events in every state, codes in every state, three customers, and orders to cancel. */
async function world(): Promise<World> {
  await venue(t.db, { id: "on-sale" });
  await venue(t.db, { id: "early-bird", startsAtMs: NOW + 60 * DAY });
  await venue(t.db, { id: "sold-out", seatsSold: 100 });
  await venue(t.db, { id: "started", startsAtMs: NOW - HOUR });
  await venue(t.db, { id: "cancelled", cancelledAtMs: NOW - DAY });
  await addCode(t.db, "WELCOME10", 10);
  await addCode(t.db, "EXPIRED", 20, { expiresAtMs: NOW - DAY });
  await addCode(t.db, "USEDUP", 30, { maxUses: 1, uses: 1 });

  const anna = await customer(auth, "Anna");
  const bela = await customer(auth, "Bela");
  const readOnlyKey = (await scopedKey(auth, anna.id, "read")).key;
  const gone = await customer(auth, "Gone");
  await revokeKey(auth, gone);

  // Orders 1 and 3 are Anna's (3 is refunded already), order 2 is Bela's.
  for (const c of [anna, bela, anna]) {
    const r = await call({ method: "POST", path: "/api/v1/orders", json: { eventId: "on-sale", tickets: 2 }, headers: { ...bearer(c.key), "idempotency-key": uniqueId("w") }, nowMs: NOW });
    expect(r.status, r.text).toBe(201);
  }
  const refunded = await call({ method: "POST", path: "/api/v1/orders/3/cancel", headers: bearer(anna.key), nowMs: NOW });
  expect(refunded.status, refunded.text).toBe(200);
  return { anna, bela, readOnlyKey, revokedKey: gone.key };
}

async function toCall(w: World, r: ApiRequest): Promise<Call> {
  const headers: Record<string, string> = {};
  if (r.who === "own key") headers.authorization = `Bearer ${await freshKey(w.anna)}`;
  else if (r.who === "other customer's key") headers.authorization = `Bearer ${await freshKey(w.bela)}`;
  else if (r.who === "read-only key") headers.authorization = `Bearer ${w.readOnlyKey}`;
  else if (r.who === "revoked key") headers.authorization = `Bearer ${w.revokedKey}`;
  else if (r.who !== undefined) headers.authorization = r.who.authorization;
  if (r.idempotencyKey !== undefined) headers["idempotency-key"] = r.idempotencyKey;
  if (r.contentType !== undefined) headers["content-type"] = r.contentType;
  if (r.accept !== undefined) headers.accept = r.accept;
  if (typeof r.clock === "string") headers.cookie = `tb-test-now=${r.clock}`;
  return {
    method: r.method,
    path: `/api/v1${r.path}`,
    headers,
    nowMs: typeof r.clock === "number" ? r.clock : undefined,
    ...(r.body && "json" in r.body ? { json: r.body.json } : {}),
    ...(r.body && "raw" in r.body ? { rawBody: r.body.raw } : {}),
  };
}

/** Below 500, and JSON — errors as {"error": "..."} a person can read, with nothing internal in it. */
function expectRobust(r: Reply) {
  expect(r.status, `${r.status} ${r.text}`).toBeLessThan(500);
  expect(r.isJson, `${r.status}, not JSON: ${JSON.stringify(r.text)}`).toBe(true);
  expect(r.headers.get("content-type")).toMatch(/^application\/json/);
  if (r.status >= 400) {
    expect(r.body, r.text).toEqual({ error: expect.any(String) });
    expect(r.body.error).not.toMatch(/\n\s+at |Failed query|postgres|drizzle/i);
  }
}

describe("1. robustness", () => {
  it("any request under /api/v1 gets a status below 500 and a JSON body", async () => {
    const w = await world();
    await fc.assert(
      fc.asyncProperty(apiRequest, async (r) => {
        expectRobust(await call(await toCall(w, r)));
      }),
      runs(800),
    );
  }, 60_000);
});

// ---- 2. Valid input → success ----------------------------------------------------

interface ValidOrder {
  startMs: number;
  bookedMs: number;
  priceCents: number;
  seatsSold: number;
  tickets: number;
  codePercent: number | undefined;
}

/**
 * A valid order, aimed at the hard clocks. The event starts at a quarter hour
 * 1-60 days after a DST change; the booking is one of:
 *  - within two hours of the early-bird end (start − 30 × 24 h), minute by
 *    minute, 0 included — for the first 30 days after a change that window
 *    crosses the change;
 *  - on the day of the change itself;
 *  - any minute up to 90 days before the start.
 */
const validOrder: fc.Arbitrary<ValidOrder> = fc
  .record({
    change: fc.constantFrom(...DST_CHANGES),
    startDays: fc.integer({ min: 1, max: 60 }),
    startQuarter: fc.integer({ min: 0, max: 95 }),
    booked: fc.oneof(
      { weight: 4, arbitrary: fc.integer({ min: -120, max: 120 }).map((minutes) => ({ nearEarlyBirdEnd: minutes })) },
      fc.integer({ min: -12 * 60, max: 12 * 60 }).map((minutes) => ({ onChangeDay: minutes })),
      fc.integer({ min: 1, max: 90 * 24 * 60 }).map((minutes) => ({ beforeStart: minutes })),
    ),
    // from €1: a free event is valid too, but its price could not show what the early-bird changed (property 3 covers it)
    priceCents: fc.integer({ min: 100, max: 100_000 }),
    seatsSold: fc.integer({ min: 0, max: 950 }),
    tickets: fc.integer({ min: 1, max: 50 }),
    codePercent: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
  })
  .map(({ change, startDays, startQuarter, booked, ...rest }) => {
    const startMs = change + startDays * DAY + startQuarter * 15 * MIN;
    const bookedMs =
      "nearEarlyBirdEnd" in booked
        ? startMs - EARLY_BIRD_MS + booked.nearEarlyBirdEnd * MIN
        : "onChangeDay" in booked
          ? change + booked.onChangeDay * MIN
          : startMs - booked.beforeStart * MIN;
    const order = { startMs, bookedMs, ...rest };
    const code = rest.codePercent === undefined ? "no code" : `code ${rest.codePercent}%`;
    return shown(order, `event starts ${budapest(startMs)}, booked ${budapest(bookedMs)}: ${rest.tickets} × ${rest.priceCents} cents, ${code}`);
  });

describe("2. valid input → success", () => {
  it("every valid order is a 201 with the right price, on DST days and at the early-bird boundary too", async () => {
    const anna = await customer(auth, "Anna");
    await fc.assert(
      fc.asyncProperty(validOrder, async (o) => {
        const ev = await venue(t.db, { id: uniqueId("ev"), priceCents: o.priceCents, startsAtMs: o.startMs, totalSeats: 1000, seatsSold: o.seatsSold, createdAtMs: o.bookedMs - DAY });
        const cart: { eventId: string; tickets: number; code?: string } = { eventId: ev.id, tickets: o.tickets };
        if (o.codePercent !== undefined) {
          cart.code = uniqueId("CODE").toUpperCase();
          await addCode(t.db, cart.code, o.codePercent, { createdAtMs: o.bookedMs - DAY });
        }

        const published = await call({ path: `/api/v1/events/${ev.id}`, nowMs: o.bookedMs });
        expect(published.status, published.text).toBe(200);
        const r = await call({ method: "POST", path: "/api/v1/orders", json: cart, headers: { ...bearer(await freshKey(anna)), "idempotency-key": uniqueId("v") }, nowMs: o.bookedMs });

        expect(r.status, r.text).toBe(201);
        expect(r.body.order).toMatchObject({ eventId: ev.id, tickets: o.tickets, status: "paid", createdAt: new Date(o.bookedMs).toISOString() });
        // The early-bird the order got is the one the event page promised at that moment...
        const promised = o.bookedMs <= Date.parse(published.body.earlyBirdEndsAt);
        expect(r.body.order.price.earlyBirdPercent, `early-bird promised until ${budapest(Date.parse(published.body.earlyBirdEndsAt))}`).toBe(promised ? 10 : 0);
        // ...and the whole price is the model's: early-bird iff booked at least 30 × 24 hours before the start.
        const earlyBird = o.startMs - o.bookedMs >= EARLY_BIRD_MS;
        expect(r.body.order.price).toEqual(modelPrice({ priceCents: o.priceCents, tickets: o.tickets, earlyBird, codePercent: o.codePercent ?? 0 }));
      }),
      runs(150),
    );
  }, 60_000);
});

// ---- 3. Oracle -------------------------------------------------------------------

describe("3. oracle", () => {
  it("a quote is the simple price model: price × count − capped discounts, rounded once, + the fee", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          priceCents: fc.integer({ min: 0, max: 100_000 }),
          tickets: fc.integer({ min: 1, max: 50 }),
          // how long before the start the quote is asked: both sides of the 30-day early-bird line
          leadMs: fc.oneof(fc.integer({ min: 1, max: 90 * DAY }), fc.constantFrom(EARLY_BIRD_MS, EARLY_BIRD_MS - 1, EARLY_BIRD_MS + 1)),
          codePercent: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
        }),
        async (q) => {
          const ev = await venue(t.db, { id: uniqueId("ev"), priceCents: q.priceCents, startsAtMs: NOW + q.leadMs, totalSeats: 1000, seatsSold: 0 });
          const cart: { eventId: string; tickets: number; code?: string } = { eventId: ev.id, tickets: q.tickets };
          if (q.codePercent !== undefined) {
            cart.code = uniqueId("CODE").toUpperCase();
            await addCode(t.db, cart.code, q.codePercent);
          }
          const r = await call({ method: "POST", path: "/api/v1/quote", json: cart, nowMs: NOW });
          expect(r.status, r.text).toBe(200);
          expect(r.body.price).toEqual(modelPrice({ priceCents: q.priceCents, tickets: q.tickets, earlyBird: q.leadMs >= EARLY_BIRD_MS, codePercent: q.codePercent ?? 0 }));
        },
      ),
      runs(300),
    );
  }, 60_000);
});

// ---- 4. Stateful sequences -------------------------------------------------------

type User = "anna" | "bela" | "cili";
const USERS: User[] = ["anna", "bela", "cili"];
type Ev = "a" | "b";

/** The two events of a sequence: a small one starting in 2 days, a smaller early-bird one in 35 days. */
const EVENTS: Record<Ev, { seats: number; startsIn: number; priceCents: number }> = {
  a: { seats: 6, startsIn: 2 * DAY, priceCents: 3000 },
  b: { seats: 4, startsIn: 35 * DAY, priceCents: 4999 },
};

interface ModelOrder {
  id: number;
  owner: User;
  ev: Ev;
  tickets: number;
  ticketsCents: number;
  refunded: boolean;
  seatsKept: boolean;
}

interface Model {
  now: number;
  orders: ModelOrder[];
  /** "anna:k1" → the order that key created */
  keys: Map<string, number>;
}

interface Real {
  run: string;
  apiKeys: Record<User, string>;
  eventId: Record<Ev, string>;
}

const seatsSold = (m: Model, ev: Ev) => m.orders.filter((o) => o.ev === ev && (!o.refunded || o.seatsKept)).reduce((n, o) => n + o.tickets, 0);
const startOf = (ev: Ev) => NOW + EVENTS[ev].startsIn;
const at = (m: Model) => m.now;

/** What an order request should get, by the model: a replay, a new order, or a refusal. */
function expectedOrder(m: Model, user: User, ev: Ev, tickets: number, key: string): "replay" | "created" | "refused" {
  if (m.keys.has(`${user}:${key}`)) return "replay";
  if (m.now >= startOf(ev)) return "refused";
  if (seatsSold(m, ev) + tickets > EVENTS[ev].seats) return "refused";
  return "created";
}

function recordOrder(m: Model, user: User, ev: Ev, tickets: number, key: string, r: Reply) {
  const o = r.body.order;
  m.orders.push({ id: o.id, owner: user, ev, tickets, ticketsCents: o.price.ticketsCents, refunded: false, seatsKept: false });
  m.keys.set(`${user}:${key}`, o.id);
}

function checkOrderReply(m: Model, r: Reply, expected: ReturnType<typeof expectedOrder>, user: User, ev: Ev, tickets: number, key: string) {
  if (expected === "replay") {
    expect(r.status, r.text).toBe(200);
    expect(r.body.order.id).toBe(m.keys.get(`${user}:${key}`));
  } else if (expected === "refused") {
    expect(r.status, r.text).toBe(422);
  } else {
    expect(r.status, r.text).toBe(201);
    const earlyBird = startOf(ev) - m.now >= EARLY_BIRD_MS;
    expect(r.body.order.price).toEqual(modelPrice({ priceCents: EVENTS[ev].priceCents, tickets, earlyBird, codePercent: 0 }));
  }
}

const orderCall = (real: Real, m: Model, user: User, ev: Ev, tickets: number, key: string): Call => ({
  method: "POST",
  path: "/api/v1/orders",
  json: { eventId: real.eventId[ev], tickets },
  headers: { ...bearer(real.apiKeys[user]), "idempotency-key": `${real.run}:${key}` },
  nowMs: at(m),
});

class Quote implements fc.AsyncCommand<Model, Real> {
  constructor(readonly user: User, readonly ev: Ev, readonly tickets: number) {}
  check = () => true;
  async run(m: Model, real: Real) {
    const r = await call({ method: "POST", path: "/api/v1/quote", json: { eventId: real.eventId[this.ev], tickets: this.tickets }, nowMs: at(m) });
    if (m.now >= startOf(this.ev) || seatsSold(m, this.ev) + this.tickets > EVENTS[this.ev].seats) {
      expect(r.status, r.text).toBe(422);
    } else {
      expect(r.status, r.text).toBe(200);
      expect(r.body.price).toEqual(modelPrice({ priceCents: EVENTS[this.ev].priceCents, tickets: this.tickets, earlyBird: startOf(this.ev) - m.now >= EARLY_BIRD_MS, codePercent: 0 }));
    }
    await checkInvariants(m, real);
  }
  toString = () => `${this.user} quotes ${this.tickets} × event ${this.ev}`;
}

class Order implements fc.AsyncCommand<Model, Real> {
  constructor(readonly user: User, readonly ev: Ev, readonly tickets: number, readonly key: string) {}
  check = () => true;
  async run(m: Model, real: Real) {
    const expected = expectedOrder(m, this.user, this.ev, this.tickets, this.key);
    const r = await call(orderCall(real, m, this.user, this.ev, this.tickets, this.key));
    checkOrderReply(m, r, expected, this.user, this.ev, this.tickets, this.key);
    if (expected === "created") recordOrder(m, this.user, this.ev, this.tickets, this.key, r);
    await checkInvariants(m, real);
  }
  toString = () => `${this.user} orders ${this.tickets} × event ${this.ev} (Idempotency-Key ${this.key})`;
}

/** The same order sent twice at the same moment, as a client that timed out and retried would. */
class OrderTwiceAtOnce implements fc.AsyncCommand<Model, Real> {
  constructor(readonly user: User, readonly ev: Ev, readonly tickets: number, readonly key: string) {}
  check = () => true;
  async run(m: Model, real: Real) {
    const expected = expectedOrder(m, this.user, this.ev, this.tickets, this.key);
    const [a, b] = await Promise.all([call(orderCall(real, m, this.user, this.ev, this.tickets, this.key)), call(orderCall(real, m, this.user, this.ev, this.tickets, this.key))]);
    if (expected === "created") {
      const [first, second] = a!.status === 201 ? [a!, b!] : [b!, a!];
      checkOrderReply(m, first, "created", this.user, this.ev, this.tickets, this.key);
      recordOrder(m, this.user, this.ev, this.tickets, this.key, first);
      checkOrderReply(m, second, "replay", this.user, this.ev, this.tickets, this.key);
    } else {
      checkOrderReply(m, a!, expected, this.user, this.ev, this.tickets, this.key);
      checkOrderReply(m, b!, expected, this.user, this.ev, this.tickets, this.key);
    }
    await checkInvariants(m, real);
  }
  toString = () => `${this.user} orders ${this.tickets} × event ${this.ev} twice at once (Idempotency-Key ${this.key})`;
}

/** Cancel one of your own orders: refunded by the rule before the start, 0 from the start on; a second time is refused. */
class CancelOwn implements fc.AsyncCommand<Model, Real> {
  private target = "";
  constructor(readonly user: User, readonly pick: number) {}
  check = (m: Readonly<Model>) => m.orders.some((o) => o.owner === this.user);
  async run(m: Model, real: Real) {
    const own = m.orders.filter((o) => o.owner === this.user);
    const o = own[this.pick % own.length]!;
    this.target = `order #${o.id}`;
    const r = await call({ method: "POST", path: `/api/v1/orders/${o.id}/cancel`, headers: bearer(real.apiKeys[this.user]), nowMs: at(m) });
    if (o.refunded) {
      expect(r).toMatchObject({ status: 422, body: { error: "This order has already been refunded." } });
    } else {
      expect(r.status, r.text).toBe(200);
      const started = m.now >= startOf(o.ev);
      expect(r.body.refund).toEqual(started ? { refundCents: 0, refundFeeCents: 0, seatsReleased: false } : { ...modelRefund(o.ticketsCents), seatsReleased: true });
      o.refunded = true;
      o.seatsKept = started;
    }
    await checkInvariants(m, real);
  }
  toString = () => `${this.user} cancels own ${this.target || `order (pick ${this.pick})`}`;
}

/** Try to cancel someone else's order: "Order not found.", and nothing changes. */
class CancelOthers implements fc.AsyncCommand<Model, Real> {
  private target = "";
  constructor(readonly user: User, readonly pick: number) {}
  check = (m: Readonly<Model>) => m.orders.some((o) => o.owner !== this.user);
  async run(m: Model, real: Real) {
    const theirs = m.orders.filter((o) => o.owner !== this.user);
    const o = theirs[this.pick % theirs.length]!;
    this.target = `${o.owner}'s order #${o.id}`;
    const r = await call({ method: "POST", path: `/api/v1/orders/${o.id}/cancel`, headers: bearer(real.apiKeys[this.user]), nowMs: at(m) });
    expect(r).toMatchObject({ status: 404, body: { error: "Order not found." } });
    await checkInvariants(m, real);
  }
  toString = () => `${this.user} tries to cancel ${this.target || `someone else's order (pick ${this.pick})`}`;
}

type Tick = "+1 hour" | "+1 day" | "+30 days" | "to event a's start" | "to 1 ms before event b's start" | "past both starts";

class MoveClock implements fc.AsyncCommand<Model, Real> {
  constructor(readonly tick: Tick) {}
  check = () => true;
  async run(m: Model, real: Real) {
    const to: Record<Tick, number> = {
      "+1 hour": m.now + HOUR,
      "+1 day": m.now + DAY,
      "+30 days": m.now + 30 * DAY,
      "to event a's start": startOf("a"),
      "to 1 ms before event b's start": startOf("b") - 1,
      "past both starts": startOf("b") + DAY,
    };
    m.now = Math.max(m.now, to[this.tick]); // time only moves forward
    await checkInvariants(m, real);
  }
  toString = () => `clock ${this.tick}`;
}

const user = fc.constantFrom(...USERS);
const ev = fc.constantFrom<Ev>("a", "b");
const n = fc.integer({ min: 1, max: 4 });
const key = fc.constantFrom("k1", "k2", "k3");
const commands = fc.commands(
  [
    fc.tuple(user, ev, n).map(([u, e, k]) => new Quote(u, e, k)),
    fc.tuple(user, ev, n, key).map(([u, e, k, i]) => new Order(u, e, k, i)),
    fc.tuple(user, ev, n, key).map(([u, e, k, i]) => new OrderTwiceAtOnce(u, e, k, i)),
    fc.tuple(user, ev, n, key).map(([u, e, k, i]) => new Order(u, e, k, i)),
    fc.tuple(user, fc.nat(20)).map(([u, p]) => new CancelOwn(u, p)),
    fc.tuple(user, fc.nat(20)).map(([u, p]) => new CancelOwn(u, p)),
    fc.tuple(user, fc.nat(20)).map(([u, p]) => new CancelOthers(u, p)),
    fc.constantFrom<Tick>("+1 hour", "+1 day", "+30 days", "to event a's start", "to 1 ms before event b's start", "past both starts").map((tk) => new MoveClock(tk)),
  ],
  // Order and CancelOwn are listed twice: they are the steps that move money.
  { maxCommands: 25, size: "+1" },
);

/** The rules that hold after every step, read from the database and the payment provider. */
async function checkInvariants(m: Model, real: Real) {
  const evs = await t.db.select().from(events).where(like(events.id, `${real.run}-%`));
  const rows = await t.db.select().from(orders).where(like(orders.idempotencyKey, `api:%:${real.run}:%`));

  // A reused Idempotency-Key never makes a second order: the database holds exactly the model's orders.
  expect(rows.map((o) => o.id).sort((x, y) => x - y)).toEqual(m.orders.map((o) => o.id).sort((x, y) => x - y));

  for (const e of evs) {
    const holding = rows.filter((o) => o.eventId === e.id && (o.status === "paid" || o.seatsReleased === false));
    expect(e.seatsSold, `${e.id}: seats sold`).toBeLessThanOrEqual(e.totalSeats);
    expect(e.seatsSold, `${e.id}: seats sold = seats the orders hold`).toBe(holding.reduce((s, o) => s + o.quantity, 0));
  }
  for (const o of rows) {
    if (o.status !== "refunded") continue;
    const e = evs.find((x) => x.id === o.eventId)!;
    expect(o.refundCents! + o.refundFeeCents!, `order ${o.id}: refund + fee ≤ tickets paid`).toBeLessThanOrEqual(o.ticketsCents);
    if (o.refundedAtMs! >= e.startsAtMs) expect(o.refundCents, `order ${o.id}: refunded after the start`).toBe(0);
  }

  // Money is conserved: what the provider holds is what the live orders hold.
  let atProvider = 0;
  for (const id of charged) {
    const c = (await payments.getCharge(id))!;
    atProvider += c.amountCents - c.refundedCents;
  }
  const inOrders = rows.reduce((s, o) => s + o.totalCents - (o.refundCents ?? 0), 0);
  expect(atProvider, "charges − refunds at the provider = totals − refunds of the orders").toBe(inOrders);
}

describe("4. stateful sequences", () => {
  it("any sequence of quotes, orders, retries, cancels and clock moves keeps every invariant", async () => {
    const people = { anna: await customer(auth, "Anna"), bela: await customer(auth, "Bela"), cili: await customer(auth, "Cili") };
    await fc.assert(
      fc.asyncProperty(commands, async (cmds) => {
        const run = uniqueId("s");
        charged.clear(); // the money invariant adds up this sequence's charges only
        const real: Real = {
          run,
          apiKeys: { anna: await freshKey(people.anna), bela: await freshKey(people.bela), cili: await freshKey(people.cili) },
          eventId: { a: `${run}-a`, b: `${run}-b` },
        };
        for (const e of ["a", "b"] as const) {
          await venue(t.db, { id: real.eventId[e], startsAtMs: startOf(e), totalSeats: EVENTS[e].seats, seatsSold: 0, priceCents: EVENTS[e].priceCents });
        }
        await fc.asyncModelRun(() => ({ model: { now: NOW, orders: [], keys: new Map() }, real }), cmds);
      }),
      runs(40),
    );
  }, 180_000);
});
