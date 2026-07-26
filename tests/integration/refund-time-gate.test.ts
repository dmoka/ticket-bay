// Integration tests for the refund WINDOW against REAL Postgres (Testcontainers).
//
// src/refund.ts:16-17 states the rule as a business rule, not a suggestion:
//   "Business rule: cancellations are only allowed BEFORE the event starts.
//    From `eventStartMs` on, the refund is zero."
//
// "From `eventStartMs` on" makes the boundary closed: eventStartMs itself is already
// too late. The existing integration coverage only ever asks for a refund at
// `eventStartMs - 1` or earlier (tests/integration/refund-persistence.test.ts:200,
// tests/integration/orders-storage.test.ts:78, tests/integration/orders-repo.test.ts:37),
// so the open side of the window is well pinned and the closed side is not exercised
// anywhere. This file covers the closed side.
//
// It belongs at the integration level because the cut-off compares `nowMs` against an
// `eventStartMs` that Postgres hands back from a BIGINT column as a *string*, coerced
// with Number() in getOrder (src/orders-repo.ts:46). A gate is only as trustworthy as
// the value it reads, so every order here is written to the database and read back
// before any clock comparison happens.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { initSchema, saveOrder, getOrder, markRefunded, isRefunded } from "../../src/orders-repo";
import { calculateRefund, netRefund, Order } from "../../src/refund";

let container: StartedPostgreSqlContainer;
let db: Client;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  db = new Client({ connectionString: container.getConnectionUri() });
  await db.connect();
}, 120000);

afterAll(async () => {
  await db?.end();
  await container?.stop();
});

// Fresh schema for every test — no state survives from one test to the next.
beforeEach(async () => {
  await db.query(`DROP TABLE IF EXISTS orders`);
  await initSchema(db);
});

/** Persist an order and read it back, so assertions run on what the database returned. */
async function roundTrip(o: Order): Promise<Order> {
  const id = await saveOrder(db, o);
  const loaded = await getOrder(db, id);
  expect(loaded).not.toBeNull();
  return loaded!;
}

const EVENT_START = 1_800_000_000_000; // 2027-01-15, past INT4, stored in a BIGINT column
const HOUR = 3_600_000;
const DAY = 86_400_000;

const anOrder = (over: Partial<Order> = {}): Order => ({
  totalCents: 10_000,
  tickets: 4,
  discountPercent: 0,
  eventStartMs: EVENT_START,
  ...over,
});

describe("the refund window closes at the stored event start (real Postgres)", () => {
  it("refunds nothing at exactly the stored event start", async () => {
    const loaded = await roundTrip(anOrder());

    // "From `eventStartMs` on, the refund is zero" — the start instant is already closed.
    expect(calculateRefund(loaded, 4, loaded.eventStartMs)).toBe(0);
  });

  it("refunds nothing one millisecond after the stored event start", async () => {
    const loaded = await roundTrip(anOrder());

    expect(calculateRefund(loaded, 4, loaded.eventStartMs + 1)).toBe(0);
  });

  it("refunds nothing an hour and a day into a started event", async () => {
    const loaded = await roundTrip(anOrder());

    expect(calculateRefund(loaded, 4, loaded.eventStartMs + HOUR)).toBe(0);
    expect(calculateRefund(loaded, 4, loaded.eventStartMs + DAY)).toBe(0);
  });

  it("still refunds in full one millisecond before the stored event start", async () => {
    // The open side, asserted alongside the closed one so the boundary is pinned from
    // both directions: closing the window must not close it a millisecond early.
    const loaded = await roundTrip(anOrder());

    expect(calculateRefund(loaded, 4, loaded.eventStartMs - 1)).toBe(10_000);
  });

  it("nets nothing to the customer once the event has started", async () => {
    const loaded = await roundTrip(anOrder());

    expect(netRefund(loaded, 4, loaded.eventStartMs)).toBe(0);
    expect(netRefund(loaded, 4, loaded.eventStartMs + HOUR)).toBe(0);
  });

  it("closes the window for partial cancellations too", async () => {
    const loaded = await roundTrip(anOrder());

    // A single ticket out of four is still a cancellation, and cancellations are closed.
    for (const cancelled of [1, 2, 3, 4]) {
      expect(calculateRefund(loaded, cancelled, loaded.eventStartMs)).toBe(0);
      expect(netRefund(loaded, cancelled, loaded.eventStartMs)).toBe(0);
    }
  });

  it("cannot be drained one ticket at a time after the event has started", async () => {
    // Per-call rounding is what makes piecemeal cancellation over-pay before the event
    // (src/refund.ts:21-27). After it, every call must be zero, so the sum is zero too.
    const loaded = await roundTrip(anOrder({ totalCents: 150, tickets: 300 }));

    let paidOut = 0;
    for (let i = 0; i < 300; i++) {
      paidOut += calculateRefund(loaded, 1, loaded.eventStartMs);
    }

    expect(paidOut).toBe(0);
  });

  it("still rejects an out-of-range cancellation after the event, rather than returning zero", async () => {
    // The window closing must not swallow input validation: an impossible request is
    // still an error, not a silent zero.
    const loaded = await roundTrip(anOrder());

    expect(() => calculateRefund(loaded, 5, loaded.eventStartMs + HOUR)).toThrow(RangeError);
    expect(() => calculateRefund(loaded, -1, loaded.eventStartMs + HOUR)).toThrow(RangeError);
  });

  it("still refuses a broken clock after the event, rather than returning zero by luck", async () => {
    const loaded = await roundTrip(anOrder());

    for (const badClock of [NaN, Infinity, -Infinity]) {
      expect(() => calculateRefund(loaded, 4, badClock)).toThrow(RangeError);
    }
  });
});

describe("the closed window reads the event start Postgres returned (real Postgres)", () => {
  it("closes on a start that only a BIGINT column can hold", async () => {
    // Past INT4, so this value exists only because the column was widened
    // (src/orders-repo.ts:9-13). The gate has to work on what came back.
    const loaded = await roundTrip(anOrder({ eventStartMs: 4_000_000_000_000 }));

    expect(loaded.eventStartMs).toBe(4_000_000_000_000);
    expect(calculateRefund(loaded, 4, loaded.eventStartMs)).toBe(0);
    expect(calculateRefund(loaded, 4, loaded.eventStartMs - 1)).toBe(10_000);
  });

  it("closes at the largest storable event start", async () => {
    const loaded = await roundTrip(anOrder({ eventStartMs: Number.MAX_SAFE_INTEGER }));

    expect(loaded.eventStartMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(calculateRefund(loaded, 4, Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it("closes on an order whose event started before the real wall clock", async () => {
    // The ordinary production case: an old order, refunded against Date.now().
    const now = Date.now();
    const loaded = await roundTrip(anOrder({ eventStartMs: now - DAY }));

    expect(calculateRefund(loaded, 4, now)).toBe(0);
    expect(netRefund(loaded, 4, now)).toBe(0);
  });
});

describe("the persisted refund lane respects the window (real Postgres)", () => {
  it("pays out nothing on a stored order whose event has started", async () => {
    // The whole lane the server drives: load the order, price the refund, record it.
    const id = await saveOrder(db, anOrder({ totalCents: 250_000, tickets: 5 }));
    const loaded = (await getOrder(db, id))!;
    const now = loaded.eventStartMs + HOUR;

    const payout = (await markRefunded(db, id)) ? netRefund(loaded, loaded.tickets, now) : 0;

    expect(payout).toBe(0);
    expect(await isRefunded(db, id)).toBe(true);
  });

  it("does not pay out a large stored total after the event", async () => {
    // The size of the hole: the whole paid total leaves on a request that should be
    // refused, on an order the schema was widened specifically to admit.
    const loaded = await roundTrip(
      anOrder({ totalCents: Number.MAX_SAFE_INTEGER, tickets: 3 }),
    );

    expect(calculateRefund(loaded, 3, loaded.eventStartMs)).toBe(0);
    expect(netRefund(loaded, 3, loaded.eventStartMs)).toBe(0);
  });

  it("never pays more in total than was paid, across an open then a closed request", async () => {
    const order = anOrder({ totalCents: 10_000, tickets: 4 });
    const id = await saveOrder(db, order);
    const loaded = (await getOrder(db, id))!;

    // Cancel two tickets while the window is open, then try for the rest after it shuts.
    const openPayout = calculateRefund(loaded, 2, loaded.eventStartMs - HOUR);
    const closedPayout = calculateRefund(loaded, 2, loaded.eventStartMs);

    expect(openPayout).toBe(5_000);
    expect(closedPayout).toBe(0);
    expect(openPayout + closedPayout).toBeLessThanOrEqual(order.totalCents);
  });

  it("leaves a zero-total order at zero on both sides of the window", async () => {
    // A fully discounted order must not become distinguishable by the gate: zero either way.
    const loaded = await roundTrip(anOrder({ totalCents: 0, discountPercent: 100 }));

    expect(calculateRefund(loaded, 4, loaded.eventStartMs - HOUR)).toBe(0);
    expect(calculateRefund(loaded, 4, loaded.eventStartMs)).toBe(0);
  });
});

/** The next representable double above `v`. */
function nextUp(v: number): number {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = v;
  const bits = new BigUint64Array(buf);
  bits[0] += 1n;
  return new Float64Array(buf)[0];
}

// A gate that returned zero for everything would satisfy most of the tests above, so
// these ask the harder question: does it cut at the right instant, on the value the
// database returned? Each one pins a full refund and a zero refund at two clocks that
// are as close together as the stored representation allows. They also exercise the
// column change underneath: event_start_ms is now DOUBLE PRECISION
// (src/orders-repo.ts:24), so the precision the cut-off can resolve is a storage
// property now, not just an arithmetic one.
describe("the cut-off discriminates adjacent instants, not merely zero (real Postgres)", () => {
  it("separates one whole millisecond at an ordinary event start", async () => {
    const loaded = await roundTrip(anOrder());

    expect(calculateRefund(loaded, 4, loaded.eventStartMs - 1)).toBe(10_000);
    expect(calculateRefund(loaded, 4, loaded.eventStartMs)).toBe(0);
  });

  it("separates one millisecond at the largest safe integer start", async () => {
    // Precision is tightest here: at MAX_SAFE_INTEGER a double can still resolve 1,
    // and one step further it cannot. If the column rounded, these two would collide.
    const loaded = await roundTrip(anOrder({ eventStartMs: Number.MAX_SAFE_INTEGER }));

    expect(loaded.eventStartMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(calculateRefund(loaded, 4, Number.MAX_SAFE_INTEGER - 1)).toBe(10_000);
    expect(calculateRefund(loaded, 4, Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it("separates a half millisecond at a fractional event start", async () => {
    // The sub-millisecond start is the case the widened column exists for
    // (src/orders-repo.ts:15-22). A gate reading a truncated start would open the
    // window half a millisecond early, so this ties the two fixes together.
    const loaded = await roundTrip(anOrder({ eventStartMs: EVENT_START + 0.5 }));

    expect(loaded.eventStartMs).toBe(EVENT_START + 0.5);
    expect(calculateRefund(loaded, 4, EVENT_START + 0.4)).toBe(10_000);
    expect(calculateRefund(loaded, 4, EVENT_START)).toBe(10_000);
    expect(calculateRefund(loaded, 4, EVENT_START + 0.5)).toBe(0);
    expect(calculateRefund(loaded, 4, EVENT_START + 0.6)).toBe(0);
  });

  it("separates the two closest instants the machine can represent", async () => {
    // The tightest boundary that exists: adjacent doubles, one ULP apart.
    const start = nextUp(EVENT_START);
    const loaded = await roundTrip(anOrder({ eventStartMs: start }));

    expect(loaded.eventStartMs).toBe(start);
    expect(calculateRefund(loaded, 4, EVENT_START)).toBe(10_000);
    expect(calculateRefund(loaded, 4, start)).toBe(0);
  });

  it("separates one millisecond at a pre-epoch event start", async () => {
    // Negative timestamps are finite, so the domain admits them and the column stores
    // them. The comparison must not depend on the sign.
    const start = -2_208_988_800_000; // 1900-01-01
    const loaded = await roundTrip(anOrder({ eventStartMs: start }));

    expect(loaded.eventStartMs).toBe(start);
    expect(calculateRefund(loaded, 4, start - 1)).toBe(10_000);
    expect(calculateRefund(loaded, 4, start)).toBe(0);
  });

  it("keeps every clock strictly before the start paying in full, across the range", async () => {
    // The mirror of the closed-side sweep: the window must not be shut early anywhere.
    const loaded = await roundTrip(anOrder());

    for (const delta of [1, 2, 60_000, HOUR, DAY, 365 * DAY]) {
      expect(calculateRefund(loaded, 4, loaded.eventStartMs - delta)).toBe(10_000);
    }
  });
});
