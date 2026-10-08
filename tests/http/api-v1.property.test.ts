// Property tests for the REST API (app/api/v1), at the HTTP level: generated
// Requests routed to the real route handlers (client.ts), real Better Auth
// API keys, real services, real Postgres (Testcontainers).
//
// Properties, in English:
//  1. Valid input → success. For every VALID order — an event with seats,
//     1-50 tickets, a working code or none, booked at any instant before the
//     start — the API answers 201 with the right order. Bookings lean on the
//     early-bird boundary, minute by minute, exactly 30 days included. The
//     early-bird the order got matches the end the API itself publishes
//     (earlyBirdEndsAt).
//  2. Oracle. A quote equals a simple model written here, not the production
//     code: ticket price × count, minus the summed discounts capped at 100%,
//     rounded once, plus the 3% fee kept between €1 and €20.
//  3. Stateful. Random interleaved actions by three API users — quote, order
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
import { customer, makeAuth, scopedKey, useCleanAccounts, type Customer } from "../integration/accounts";
import { useTestDatabase } from "../integration/database";
import { addCode, DAY, HOUR, NOW, venue } from "../integration/fixtures";
import { bearer, call, loadRoutes, quietRefusedKeyLogs, type Call, type Reply } from "./client";

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

const SEED = Number(process.env.FC_SEED ?? 20261004);
const runs = (numRuns: number) => ({ seed: SEED, numRuns });

/**
 * The fake payment provider, fresh for every test like the database: order
 * ids restart with the database, and a refund's idempotency key is
 * `refund-<order id>` — a provider that outlived the database would answer a
 * new order's refund with an old one. It records every charge, so property 3
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

const MIN = 60_000;
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

// ---- The price model (property 1 and 2's oracle) ------------------------------

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

// ---- 1. Valid input → success ----------------------------------------------------

interface ValidOrder {
  startMs: number;
  bookedMs: number;
  priceCents: number;
  seatsSold: number;
  tickets: number;
  codePercent: number | undefined;
}

/**
 * A valid order. The event starts an hour to 90 days after NOW; the booking is
 * within two hours of the early-bird end (start − 30 × 24 h), minute by minute,
 * 0 included — or any minute up to 90 days before the start.
 */
const validOrder: fc.Arbitrary<ValidOrder> = fc
  .record({
    startsInMin: fc.integer({ min: 60, max: 90 * 24 * 60 }),
    booked: fc.oneof(
      { weight: 2, arbitrary: fc.integer({ min: -120, max: 120 }).map((minutes) => ({ nearEarlyBirdEnd: minutes })) },
      fc.integer({ min: 1, max: 90 * 24 * 60 }).map((minutes) => ({ beforeStart: minutes })),
    ),
    // from €1: a free event is valid too, but its price could not show what the early-bird changed (property 2 covers it)
    priceCents: fc.integer({ min: 100, max: 100_000 }),
    seatsSold: fc.integer({ min: 0, max: 950 }),
    tickets: fc.integer({ min: 1, max: 50 }),
    codePercent: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
  })
  .map(({ startsInMin, booked, ...rest }) => {
    const startMs = NOW + startsInMin * MIN;
    const bookedMs = "nearEarlyBirdEnd" in booked ? startMs - EARLY_BIRD_MS + booked.nearEarlyBirdEnd * MIN : startMs - booked.beforeStart * MIN;
    const order = { startMs, bookedMs, ...rest };
    const code = rest.codePercent === undefined ? "no code" : `code ${rest.codePercent}%`;
    return shown(order, `event starts ${utc(startMs)}, booked ${utc(bookedMs)}: ${rest.tickets} × ${rest.priceCents} cents, ${code}`);
  });

describe("1. valid input → success", () => {
  it("every valid order is a 201 with the right price, at the early-bird boundary too", async () => {
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
        expect(r.body.order.price.earlyBirdPercent, `early-bird promised until ${utc(Date.parse(published.body.earlyBirdEndsAt))}`).toBe(promised ? 10 : 0);
        // ...and the whole price is the model's: early-bird iff booked at least 30 × 24 hours before the start.
        const earlyBird = o.startMs - o.bookedMs >= EARLY_BIRD_MS;
        expect(r.body.order.price).toEqual(modelPrice({ priceCents: o.priceCents, tickets: o.tickets, earlyBird, codePercent: o.codePercent ?? 0 }));
      }),
      runs(150),
    );
  }, 60_000);
});

// ---- 2. Oracle -------------------------------------------------------------------

describe("2. oracle", () => {
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

// ---- 3. Stateful sequences -------------------------------------------------------

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
  { maxCommands: 20, size: "+1" },
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

describe("3. stateful sequences", () => {
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
      runs(30),
    );
  }, 180_000);
});
