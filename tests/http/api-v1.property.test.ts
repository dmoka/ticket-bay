// Property tests for the REST API (app/api/v1), at the HTTP level: generated
// Requests into the real route handlers, real Better Auth API keys, real
// services, real Postgres (Testcontainers). Wiring as in api-v1.test.ts.
//
// Properties, in English:
//  1. Never a 500. Whatever a client sends to any endpoint — valid, boundary or
//     garbage bodies (wrong types, missing fields, huge / negative / zero /
//     fractional numbers, long and unicode strings, control characters, bad
//     JSON), any Authorization header or none, any Idempotency-Key or none, any
//     id in the path — the answer is a 2xx, or a 4xx with a JSON {error}. Never 5xx.
//  2. Quote = order. For any valid cart on an event with seats, the order's
//     price — total and every line — is exactly the quote's at the same instant.
//  3. Idempotency. The same order request with the same Idempotency-Key, sent N
//     times (one after another, or all at once), creates exactly one order,
//     takes the seats once, and every answer names that order.
//  4. The refund rule, through the API. Cancelling at or after the event start
//     refunds 0 and the seats stay sold. Before the start it refunds what was
//     paid for the tickets minus the refund fee (2%, at least 50 cents, never
//     more than the refund) — the service fee is never refunded — and the
//     seats go back on sale. The clock is moved with the test clock cookie.
//
// The seed is fixed so a failure replays exactly; fast-check prints it with
// the shrunk counterexample. FC_SEED=<n> explores a different stream.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import { and, count, eq } from "drizzle-orm";
import type { Auth } from "../../src/auth/auth";
import { getEvent } from "../../src/db/events-repo";
import { orders } from "../../src/db/schema";
import { createFakeStripe } from "../../src/payments";
import { customer, makeAuth, revokeKey, scopedKey, useCleanAccounts, type Customer } from "../integration/accounts";
import { useTestDatabase } from "../integration/database";
import { addCode, DAY, HOUR, NOW, venue } from "../integration/fixtures";
import { bearer, loadRoutes, read, request, type Call, type Reply, type Routes } from "./client";

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

let auth: Auth;
let routes: Routes;

beforeAll(async () => {
  process.env.TICKETBAY_TEST_CLOCK = "1";
  auth = makeAuth(t.db);
  wiring.auth = auth;
  wiring.db = t.db;
  wiring.payments = createFakeStripe("sk_test_property");
  routes = await loadRoutes();
});

afterAll(() => {
  delete process.env.TICKETBAY_TEST_CLOCK;
});

/** A fresh read & write key: Better Auth rate-limits each key to 120 requests a minute. */
const freshKey = async (c: Customer) => (await scopedKey(auth, c.id, "read-write")).key;

let ids = 0;
const uniqueId = (prefix: string) => `${prefix}-${++ids}`;

// ---- 1. Never a 500 ------------------------------------------------------------

// withCrossShrink: a failing value may shrink into an earlier, simpler branch,
// so a counterexample ends as short and plain as the bug allows.

/** One character: printable ASCII, an ASCII control character (NUL included), or any code point. */
const anyChar = fc.oneof(
  { withCrossShrink: true },
  { weight: 3, arbitrary: fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 1 }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 0x1f }).map((c) => String.fromCharCode(c)) },
  { weight: 1, arbitrary: fc.string({ unit: "binary", minLength: 1, maxLength: 1 }) },
);

/** Strings a client can put in JSON: any of those characters, emoji and combining marks, long ones. */
const anyString = fc.oneof(
  { withCrossShrink: true },
  fc.string({ unit: anyChar }),
  fc.string({ unit: "grapheme" }),
  fc.string({ unit: anyChar, maxLength: 3000, size: "max" }),
);

/** What a client can put where a number belongs. JSON turns NaN and ±Infinity into null. */
const anyNumberish = fc.oneof(
  fc.integer({ min: -100, max: 100 }),
  fc.constantFrom(0, -0, 1, 50, 51, -1, 0.5, 1.5, 2 ** 31, 2 ** 53, 2 ** 53 + 2, 1e308, -1e308, 5e-324),
  fc.double(),
  anyString,
  fc.boolean(),
  fc.constant(null),
);

/** Ticket counts: mostly in range, so a body gets past validation and reaches the services. */
const tickets = fc.oneof({ weight: 3, arbitrary: fc.integer({ min: 1, max: 50 }) }, { weight: 2, arbitrary: anyNumberish });

/** The world every "never a 500" property runs against. */
const EVENT_IDS = ["on-sale", "early-bird", "sold-out", "started", "cancelled"];
const CODES = ["WELCOME10", "welcome10", " WELCOME10 ", "EXPIRED", "USEDUP", ""];

const eventId = fc.oneof({ weight: 2, arbitrary: fc.constantFrom(...EVENT_IDS, "no-such-event") }, { weight: 3, arbitrary: anyString });
const code = fc.oneof(fc.constantFrom(...CODES), anyString, anyNumberish);

/** A body: a cart-shaped object (some fields missing), any JSON value, any text, or nothing. */
const body = fc.oneof(
  { weight: 4, arbitrary: fc.record({ eventId, tickets, code }, { requiredKeys: ["eventId", "tickets"] }).map((json) => ({ json })) },
  { weight: 2, arbitrary: fc.record({ eventId, tickets, code }, { requiredKeys: [] }).map((json) => ({ json })) },
  { weight: 1, arbitrary: fc.jsonValue({ maxDepth: 3 }).map((json) => ({ json })) },
  { weight: 1, arbitrary: anyString.map((raw) => ({ raw })) },
  { weight: 1, arbitrary: fc.constant({ none: true as const }) },
);

/** Who is calling. Symbolic, so a counterexample reads well; resolved to a header per run. */
const caller = fc.oneof(
  fc.constantFrom("own key", "other customer's key", "read-only key", "revoked key", "no header"),
  fc.string().map((raw) => ({ authorization: raw })),
  fc.string().map((token) => ({ authorization: `Bearer tb_${token}` })),
);

/** Idempotency-Key header values. Printable only: a Request refuses control characters in headers. */
const idempotencyKey = fc.option(fc.oneof(fc.string({ maxLength: 120 }), fc.uuid(), fc.string({ minLength: 95, maxLength: 130 })), { nil: undefined });

/** "now" for the request: mostly NOW, sometimes elsewhere in the year around it, sometimes a junk cookie. */
const clock = fc.oneof(
  { withCrossShrink: true },
  { weight: 3, arbitrary: fc.constant(NOW) },
  { weight: 1, arbitrary: fc.integer({ min: NOW - 365 * DAY, max: NOW + 365 * DAY }) },
  { weight: 1, arbitrary: fc.constant("not-a-time") },
);

/** Any string or number in a path segment, plus the ids that name real things. */
const pathId = (real: string[]) =>
  fc.oneof(fc.constantFrom(...real), anyString, fc.integer().map(String), fc.constantFrom("0", "-1", "1.5", "1e3", "2147483648", "99999999999"));

interface World {
  anna: Customer;
  bela: Customer;
  readOnlyKey: string;
  revokedKey: string;
  orderIds: string[];
}

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

  // Orders to cancel: Anna's, Bela's, and one of Anna's already refunded.
  const book = async (c: Customer) => {
    const r = await read(
      await routes.placeOrder(
        request({ method: "POST", path: "/api/v1/orders", json: { eventId: "on-sale", tickets: 2 }, headers: { ...bearer(c.key), "idempotency-key": uniqueId("w") }, nowMs: NOW }),
      ),
    );
    expect(r.status, r.text).toBe(201);
    return String(r.body.order.id);
  };
  const orderIds = [await book(anna), await book(bela), await book(anna)];
  const refunded = await read(await routes.cancelOrder(request({ method: "POST", path: "/x", headers: bearer(anna.key), nowMs: NOW }), orderIds[2]!));
  expect(refunded.status, refunded.text).toBe(200);
  return { anna, bela, readOnlyKey, revokedKey: gone.key, orderIds };
}

type Caller = typeof caller extends fc.Arbitrary<infer C> ? C : never;

async function authHeader(w: World, c: Caller): Promise<Record<string, string>> {
  if (typeof c !== "string") return c;
  switch (c) {
    case "own key":
      return bearer(await freshKey(w.anna));
    case "other customer's key":
      return bearer(await freshKey(w.bela));
    case "read-only key":
      return bearer(w.readOnlyKey);
    case "revoked key":
      return bearer(w.revokedKey);
    case "no header":
      return {};
  }
  throw new Error(`unknown caller ${c}`);
}

/** A request as generated: the parts a counterexample shows. */
interface Generated {
  body?: { json: unknown } | { raw: string } | { none: true };
  caller?: Caller;
  idempotencyKey?: string;
  clock: number | string;
}

async function send(w: World, g: Generated, path: string): Promise<Call> {
  const headers: Record<string, string> = g.caller === undefined ? {} : await authHeader(w, g.caller);
  if (g.idempotencyKey !== undefined) headers["idempotency-key"] = g.idempotencyKey;
  if (typeof g.clock === "string") headers.cookie = `tb-test-now=${g.clock}`;
  const b = g.body;
  return {
    method: b === undefined ? "GET" : "POST",
    path,
    headers,
    nowMs: typeof g.clock === "number" ? g.clock : undefined,
    ...(b && "json" in b ? { json: b.json } : {}),
    ...(b && "raw" in b ? { rawBody: b.raw } : {}),
  };
}

/** A path segment as a client would percent-encode it (the handler gets the decoded value). */
const segment = (id: string) => {
  try {
    return encodeURIComponent(id);
  } catch {
    return "_";
  }
};

/** 2xx, or 4xx with a JSON {error} a person can read. The message carries the reply for the report. */
function expectNoServerError(r: Reply) {
  expect(r.status, `${r.status} ${r.text}`).toBeLessThan(500);
  if (r.status >= 400) {
    expect(r.body, r.text).toEqual({ error: expect.any(String) });
    expect(r.body.error).not.toMatch(/\n\s+at |Failed query|postgres|drizzle/i);
  }
}

describe("1. never a 500", () => {
  it("GET /api/v1/events", async () => {
    const w = await world();
    await fc.assert(
      fc.asyncProperty(fc.record({ caller, clock }, { requiredKeys: ["clock"] }), async (g) => {
        expectNoServerError(await read(await routes.listEvents(request(await send(w, g, "/api/v1/events")))));
      }),
      runs(50),
    );
  });

  it("GET /api/v1/events/{id}", async () => {
    const w = await world();
    await fc.assert(
      fc.asyncProperty(pathId(EVENT_IDS), fc.record({ caller, clock }, { requiredKeys: ["clock"] }), async (id, g) => {
        expectNoServerError(await read(await routes.getEvent(request(await send(w, g, `/api/v1/events/${segment(id)}`)), id)));
      }),
      runs(300),
    );
  });

  it("POST /api/v1/quote", async () => {
    const w = await world();
    await fc.assert(
      fc.asyncProperty(fc.record({ body, caller, clock }, { requiredKeys: ["body", "clock"] }), async (g) => {
        expectNoServerError(await read(await routes.quote(request(await send(w, g, "/api/v1/quote")))));
      }),
      runs(500),
    );
  });

  it("POST /api/v1/orders", async () => {
    const w = await world();
    await fc.assert(
      fc.asyncProperty(fc.record({ body, caller, idempotencyKey, clock }, { requiredKeys: ["body", "caller", "clock"] }), async (g) => {
        expectNoServerError(await read(await routes.placeOrder(request(await send(w, g, "/api/v1/orders")))));
      }),
      runs(200),
    );
  });

  it("POST /api/v1/orders/{id}/cancel", async () => {
    const w = await world();
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(0, 1, 2).chain((i) => pathId([w.orderIds[i]!])), fc.record({ body, caller, clock }, { requiredKeys: ["caller", "clock"] }), async (id, g) => {
        expectNoServerError(await read(await routes.cancelOrder(request(await send(w, { ...g, body: g.body ?? { none: true } }, `/api/v1/orders/${segment(id)}/cancel`)), id)));
      }),
      runs(200),
    );
  });
});

// ---- 2-4. Money and idempotency -----------------------------------------------

/** An event with plenty of seats, starting `startsInMs` after NOW. */
async function freshEvent(priceCents: number, startsInMs: number, seatsSold = 0) {
  return venue(t.db, { id: uniqueId("ev"), priceCents, startsAtMs: NOW + startsInMs, totalSeats: 1000, seatsSold });
}

const orderAt = (key: string, json: unknown, idem: string, nowMs = NOW) =>
  routes.placeOrder(request({ method: "POST", path: "/api/v1/orders", json, headers: { ...bearer(key), "idempotency-key": idem }, nowMs })).then(read);

describe("2. quote = order", () => {
  it("for any valid cart on an event with seats, the order's price is the quote's", async () => {
    const anna = await customer(auth, "Anna");
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          priceCents: fc.integer({ min: 0, max: 100_000 }),
          // an hour to 90 days out: both sides of the 30-day early-bird line
          startsInMs: fc.integer({ min: HOUR, max: 90 * DAY }),
          tickets: fc.integer({ min: 1, max: 50 }),
          codePercent: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
        }),
        async ({ priceCents, startsInMs, tickets, codePercent }) => {
          const ev = await freshEvent(priceCents, startsInMs);
          const cart: { eventId: string; tickets: number; code?: string } = { eventId: ev.id, tickets };
          if (codePercent !== undefined) {
            cart.code = uniqueId("CODE").toUpperCase();
            await addCode(t.db, cart.code, codePercent);
          }
          const quoted = await read(await routes.quote(request({ method: "POST", path: "/api/v1/quote", json: cart, nowMs: NOW })));
          expect(quoted.status, quoted.text).toBe(200);

          const placed = await orderAt(await freshKey(anna), cart, uniqueId("q"));
          expect(placed.status, placed.text).toBe(201);
          expect(placed.body.order.price.totalCents).toBe(quoted.body.price.totalCents);
          expect(placed.body.order.price).toEqual(quoted.body.price);
        },
      ),
      runs(50),
    );
  });
});

describe("3. idempotency", () => {
  it("N sends with one Idempotency-Key make exactly one order, and every answer names it", async () => {
    const anna = await customer(auth, "Anna");
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          tickets: fc.integer({ min: 1, max: 10 }),
          times: fc.integer({ min: 2, max: 6 }),
          atOnce: fc.boolean(),
          key: fc.oneof(fc.uuid(), fc.string({ minLength: 1, maxLength: 90 })),
        }),
        async ({ tickets, times, atOnce, key }) => {
          const ev = await freshEvent(5000, 10 * DAY, 40);
          const apiKey = await freshKey(anna);
          // A run's own prefix: a key an earlier run already used would (rightly) replay that run's order.
          const idem = `${uniqueId("run")}:${key}`;
          const post = () => orderAt(apiKey, { eventId: ev.id, tickets }, idem);
          const replies = atOnce
            ? await Promise.all(Array.from({ length: times }, post))
            : await Array.from({ length: times }).reduce<Promise<Reply[]>>(async (acc) => [...(await acc), await post()], Promise.resolve([]));

          for (const r of replies) expect([200, 201], `${r.status} ${r.text}`).toContain(r.status);
          expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
          expect(new Set(replies.map((r) => r.body.order.id)).size).toBe(1);

          const [stored] = await t.db.select({ n: count() }).from(orders).where(and(eq(orders.eventId, ev.id), eq(orders.userId, anna.id)));
          expect(stored!.n).toBe(1);
          expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(40 + tickets);
        },
      ),
      runs(30),
    );
  });
});

describe("4. the refund rule, through the API", () => {
  /** The refund fee: 2% of the refund, rounded half up, at least 50 cents, never more than the refund. */
  const refundFee = (refund: number) => (refund <= 0 ? 0 : Math.min(refund, Math.max(50, Math.floor((refund * 2 + 50) / 100))));

  it("at or after the start: 0 back, seats kept; before: tickets paid minus the refund fee, seats released", async () => {
    const anna = await customer(auth, "Anna");
    await fc.assert(
      fc.asyncProperty(
        fc
          .record({
            priceCents: fc.integer({ min: 0, max: 100_000 }),
            tickets: fc.integer({ min: 1, max: 20 }),
            startsInMs: fc.integer({ min: 2, max: 60 * DAY }),
          })
          .chain((o) =>
            fc.record({
              order: fc.constant(o),
              // when the customer cancels, relative to NOW: before the start, the last ms before it, the start itself, after it
              cancelAfterMs: fc.oneof(
                fc.integer({ min: 0, max: o.startsInMs - 1 }),
                fc.constant(o.startsInMs - 1),
                fc.constant(o.startsInMs),
                fc.integer({ min: o.startsInMs, max: o.startsInMs + 400 * DAY }),
              ),
            }),
          ),
        async ({ order: o, cancelAfterMs }) => {
          const ev = await freshEvent(o.priceCents, o.startsInMs, 10);
          const key = await freshKey(anna);
          const placed = await orderAt(key, { eventId: ev.id, tickets: o.tickets }, uniqueId("r"));
          expect(placed.status, placed.text).toBe(201);
          const paid = placed.body.order.price as { ticketsCents: number; feeCents: number; totalCents: number };

          const cancelledAt = NOW + cancelAfterMs;
          const r = await read(await routes.cancelOrder(request({ method: "POST", path: "/x", headers: bearer(key), nowMs: cancelledAt }), String(placed.body.order.id)));
          expect(r.status, r.text).toBe(200);
          const seatsAfter = (await getEvent(t.db, ev.id))!.seatsSold;

          if (cancelledAt >= ev.startsAtMs) {
            expect(r.body.refund).toEqual({ refundCents: 0, refundFeeCents: 0, seatsReleased: false });
            expect(seatsAfter).toBe(10 + o.tickets);
          } else {
            const fee = refundFee(paid.ticketsCents);
            expect(r.body.refund).toEqual({ refundCents: paid.ticketsCents - fee, refundFeeCents: fee, seatsReleased: true });
            expect(seatsAfter).toBe(10);
          }
          // The service fee is never refunded.
          expect(r.body.refund.refundCents).toBeLessThanOrEqual(paid.totalCents - paid.feeCents);
          expect(r.body.order).toMatchObject({ status: "refunded", refundCents: r.body.refund.refundCents });
        },
      ),
      runs(50),
    );
  });
});
