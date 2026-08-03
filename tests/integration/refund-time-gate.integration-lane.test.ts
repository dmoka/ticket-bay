// Integration lane: the refund window closes when the event starts.
//
// The contract is stated in src/refund.ts:16-17, on calculateRefund itself:
//   "Business rule: cancellations are only allowed BEFORE the event starts.
//    From `eventStartMs` on, the refund is zero."
//
// Two other places in the source depend on that rule being real:
//   - server/server.ts:97-102 returns seats to inventory only while `now <
//     rec.order.eventStartMs`, reasoning that after the start "the customer keeps
//     neither the money nor the seat". That sentence is only true if the refund
//     is zero after the start.
//   - tests/integration/refund-persistence.test.ts:175-178 documents a cut-off
//     compared against the loaded eventStartMs and says "the closed side of the
//     boundary lives in refund-time-gate.test.ts" — a file that does not exist in
//     this repo. Every existing test in every lane picks a clock strictly BEFORE
//     the event start (`eventStartMs - HOUR`, `eventStartMs - 1`,
//     `strictlyBefore(...)`), so the open side is covered many times over and the
//     closed side is not covered at all.
//
// This file covers the closed side, and covers it where the money actually is: on
// orders written to and read back from REAL Postgres via Testcontainers, so the
// instant the gate compares against is one that survived a float8 round trip
// through the driver, not a literal typed into the test.
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

// Fresh schema for every test — nothing survives from one test to the next.
beforeEach(async () => {
  await db.query(`DROP TABLE IF EXISTS orders`);
  await initSchema(db);
});

/** Persist an order and read it back, so every assertion runs on what the database returned. */
async function roundTrip(o: Order): Promise<Order> {
  const id = await saveOrder(db, o);
  const loaded = await getOrder(db, id);
  expect(loaded).not.toBeNull();
  return loaded!;
}

const EVENT_START = 1_800_000_000_000; // 2027-01-15
const SECOND = 1_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;

// ---------------------------------------------------------------------------
// The clock helper, and its own tests.
//
// This file's whole claim rests on which side of `eventStartMs` a given clock
// falls, so the two functions that produce "the last instant before the start"
// and "the first instant of the event" are load-bearing: a wrong step would make
// every assertion below aim at the wrong side of the boundary and report a defect
// that is not there.
//
// A naive bit-increment (`bits += 1n`) is wrong in two places the domain reaches.
// IEEE-754 doubles are sign-MAGNITUDE, so adding one to the bit pattern of a
// negative double moves away from zero — downward, not upward — and the successor
// of zero lives in a different sign's bit pattern than its predecessor. The domain
// admits pre-epoch event starts (src/refund.ts:42 accepts any finite instant, and
// tests/integration/orders-storage.test.ts:157 persists a 1900 start), so the
// negative half is not hypothetical. Both directions are handled explicitly and
// verified over the entire census this file feeds them.
// ---------------------------------------------------------------------------

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);

function bitsOf(v: number): bigint {
  f64[0] = v;
  return u64[0];
}

function fromBits(b: bigint): number {
  u64[0] = b;
  return f64[0];
}

/** The next double strictly above `v`. */
function nextAfter(v: number): number {
  if (!Number.isFinite(v)) throw new RangeError("nextAfter needs a finite value");
  if (v === 0) return Number.MIN_VALUE; // covers +0 and -0: both step up to the smallest denormal
  const stepped = v > 0 ? fromBits(bitsOf(v) + 1n) : fromBits(bitsOf(v) - 1n);
  // Stepping up from the smallest negative denormal lands on IEEE's -0, which is
  // where a bit-exact round trip through zero breaks: -0 equals 0 under every
  // comparison and is a different value under Object.is. Nothing downstream can
  // tell the two apart — src/refund.ts compares with < and >=, and the pg driver
  // already collapses -0 to 0 on the way into the database
  // (tests/integration/orders-storage.test.ts:205) — so this hands back the
  // positive zero rather than a clock that is equal to another but not identical.
  return stepped === 0 ? 0 : stepped;
}

/** The next double strictly below `v`. */
function nextBefore(v: number): number {
  if (!Number.isFinite(v)) throw new RangeError("nextBefore needs a finite value");
  if (v === 0) return -Number.MIN_VALUE;
  return v > 0 ? fromBits(bitsOf(v) - 1n) : fromBits(bitsOf(v) + 1n);
}

// Every instant this file uses as an event start, plus the sign and magnitude
// boundaries that a bit-twiddling step function gets wrong.
const CLOCK_CENSUS: [string, number][] = [
  ["the event start", EVENT_START],
  ["a fractional event start", EVENT_START + 0.5],
  ["zero, the epoch", 0],
  ["a pre-epoch start (1900)", -2_208_988_800_000],
  ["a negative fractional start", -2_208_988_800_000.5],
  ["one", 1],
  ["minus one", -1],
  ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
  ["minus MAX_SAFE_INTEGER", -Number.MAX_SAFE_INTEGER],
  ["MIN_VALUE, the smallest denormal", Number.MIN_VALUE],
  ["minus MIN_VALUE", -Number.MIN_VALUE],
  ["EPSILON", Number.EPSILON],
];

describe("the clock helper this file relies on", () => {
  it.each(CLOCK_CENSUS)("steps strictly up and strictly down from %s", (_label, v) => {
    expect(nextAfter(v)).toBeGreaterThan(v);
    expect(nextBefore(v)).toBeLessThan(v);
    expect(Number.isFinite(nextAfter(v))).toBe(true);
    expect(Number.isFinite(nextBefore(v))).toBe(true);
  });

  it.each(CLOCK_CENSUS)("steps back to exactly where it started from %s", (_label, v) => {
    expect(nextBefore(nextAfter(v))).toBe(v);
    expect(nextAfter(nextBefore(v))).toBe(v);
  });

  it.each(CLOCK_CENSUS)("leaves no double between %s and its neighbours", (_label, v) => {
    // The midpoint of two ADJACENT doubles is not representable, so it rounds to
    // one of the two ends. If the step skipped a value, the midpoint would be a
    // third distinct double and this would fail.
    const up = (v + nextAfter(v)) / 2;
    expect(up === v || up === nextAfter(v)).toBe(true);
    const down = (v + nextBefore(v)) / 2;
    expect(down === v || down === nextBefore(v)).toBe(true);
  });

  it("matches the steps that are known constants, independently of the bit maths", () => {
    // Reference values nobody needs a float64 layout to agree on.
    expect(nextAfter(1)).toBe(1 + Number.EPSILON);
    expect(nextBefore(1)).toBe(1 - Number.EPSILON / 2);
    expect(nextAfter(0)).toBe(Number.MIN_VALUE);
    expect(nextBefore(0)).toBe(-Number.MIN_VALUE);
    expect(nextBefore(Number.MIN_VALUE)).toBe(0);
    // Above 2^52 the gap between doubles is exactly 1, so stepping is integer
    // arithmetic and MAX_SAFE_INTEGER's neighbours are its integer neighbours.
    expect(nextAfter(Number.MAX_SAFE_INTEGER)).toBe(2 ** 53);
    expect(nextBefore(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(nextAfter(-Number.MAX_SAFE_INTEGER)).toBe(-Number.MAX_SAFE_INTEGER + 1);
    expect(nextBefore(-Number.MAX_SAFE_INTEGER)).toBe(-(2 ** 53));
  });

  it("never hands back a negative zero as a clock", () => {
    // The one place the two steps are not exact inverses in the bit pattern, pinned
    // here so the normalisation in nextAfter cannot be dropped unnoticed.
    expect(Object.is(nextAfter(-Number.MIN_VALUE), 0)).toBe(true);
    expect(nextAfter(-Number.MIN_VALUE)).toBeGreaterThan(-Number.MIN_VALUE);
    // nextBefore cannot reach zero from below and steps to +0 from above, so it has
    // nothing to normalise. Said out loud rather than assumed.
    expect(Object.is(nextBefore(Number.MIN_VALUE), 0)).toBe(true);
    for (const [, v] of CLOCK_CENSUS) {
      expect(Object.is(nextAfter(v), -0)).toBe(false);
      expect(Object.is(nextBefore(v), -0)).toBe(false);
    }
  });

  it("refuses a clock it cannot step, instead of returning a wrong one", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => nextAfter(bad)).toThrow(RangeError);
      expect(() => nextBefore(bad)).toThrow(RangeError);
    }
  });

  it("produces a sub-millisecond step at the event start, so the boundary is probed tightly", () => {
    // Not a correctness property of the helper — a statement that the "last instant
    // before the start" below really is the last one, and not a whole millisecond off.
    const gap = nextAfter(EVENT_START) - EVENT_START;
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------

const anOrder = (over: Partial<Order> = {}): Order => ({
  totalCents: 10_000,
  tickets: 4,
  discountPercent: 0,
  eventStartMs: EVENT_START,
  ...over,
});

describe("the refund window closes when the stored event starts (real Postgres)", () => {
  it("pays nothing at the exact instant the event starts", async () => {
    const loaded = await roundTrip(anOrder());

    // src/refund.ts:17: "From `eventStartMs` on, the refund is zero." `on`, not `after`.
    expect(calculateRefund(loaded, loaded.tickets, loaded.eventStartMs)).toBe(0);
    expect(netRefund(loaded, loaded.tickets, loaded.eventStartMs)).toBe(0);
  });

  const AFTER: [string, (start: number) => number][] = [
    ["the very next representable instant", (s) => nextAfter(s)],
    ["one millisecond in", (s) => s + 1],
    ["one second in", (s) => s + SECOND],
    ["an hour in", (s) => s + HOUR],
    ["the day after", (s) => s + DAY],
    ["a year later", (s) => s + YEAR],
  ];

  it.each(AFTER)("pays nothing %s", async (_label, at) => {
    const loaded = await roundTrip(anOrder());
    const now = at(loaded.eventStartMs);

    expect(now).toBeGreaterThan(loaded.eventStartMs);
    expect(calculateRefund(loaded, loaded.tickets, now)).toBe(0);
    expect(netRefund(loaded, loaded.tickets, now)).toBe(0);
  });

  it("closes the window for a partial cancellation too, not just a whole order", async () => {
    const loaded = await roundTrip(anOrder({ totalCents: 10_001, tickets: 3 }));

    for (const cancelled of [1, 2, 3]) {
      expect(calculateRefund(loaded, cancelled, loaded.eventStartMs)).toBe(0);
      expect(calculateRefund(loaded, cancelled, loaded.eventStartMs + HOUR)).toBe(0);
      expect(netRefund(loaded, cancelled, loaded.eventStartMs + HOUR)).toBe(0);
    }
  });

  it("pays nothing on the largest order the schema can hold, once the event has started", async () => {
    // The bigger the order the more a missing gate costs, so say it at the top of
    // the range calculateRefund admits (src/refund.ts:39).
    const loaded = await roundTrip(anOrder({ totalCents: Number.MAX_SAFE_INTEGER, tickets: 3 }));

    expect(calculateRefund(loaded, 3, loaded.eventStartMs)).toBe(0);
    expect(netRefund(loaded, 3, loaded.eventStartMs + DAY)).toBe(0);
  });
});

describe("the window is still open right up to the start (real Postgres)", () => {
  // The mirror of the block above. A gate that closes too early is its own defect:
  // it strands a customer who cancelled in good time with nothing back.
  it("pays in full at the last representable instant before the start", async () => {
    const loaded = await roundTrip(anOrder());
    const lastInstant = nextBefore(loaded.eventStartMs);

    expect(lastInstant).toBeLessThan(loaded.eventStartMs);
    expect(calculateRefund(loaded, loaded.tickets, lastInstant)).toBe(10_000);
    expect(netRefund(loaded, loaded.tickets, lastInstant)).toBe(9_800);
  });

  it.each([
    ["one millisecond before", 1],
    ["a second before", SECOND],
    ["an hour before", HOUR],
    ["a month before", 30 * DAY],
  ])("pays in full %s the start", async (_label, delta) => {
    const loaded = await roundTrip(anOrder());

    expect(calculateRefund(loaded, loaded.tickets, loaded.eventStartMs - delta)).toBe(10_000);
    expect(netRefund(loaded, loaded.tickets, loaded.eventStartMs - delta)).toBe(9_800);
  });
});

describe("the gate flips on the instant the database returned (real Postgres)", () => {
  // The event start is stored in a DOUBLE PRECISION column (src/orders-repo.ts:27)
  // and comes back through the pg driver's text encoding. A gate is only as
  // trustworthy as the instant it compares against, so these sweep the boundary of
  // the LOADED value for starts whose text form is awkward: fractional, pre-epoch,
  // and one whose exact double the driver has to reproduce character for character.
  const STARTS: [string, number][] = [
    ["a whole-millisecond start", EVENT_START],
    ["a half-millisecond start", EVENT_START + 0.5],
    ["a start that is not a round millisecond", EVENT_START + 0.4],
    ["a pre-epoch start (1900)", -2_208_988_800_000],
    ["the epoch itself", 0],
  ];

  it.each(STARTS)("refunds strictly before %s and never from it on", async (_label, eventStartMs) => {
    const loaded = await roundTrip(anOrder({ eventStartMs }));
    expect(loaded.eventStartMs).toBe(eventStartMs);

    const clocks: number[] = [
      loaded.eventStartMs - DAY,
      loaded.eventStartMs - 1,
      nextBefore(loaded.eventStartMs),
      loaded.eventStartMs,
      nextAfter(loaded.eventStartMs),
      loaded.eventStartMs + 1,
      loaded.eventStartMs + DAY,
    ];

    for (const now of clocks) {
      const open = now < loaded.eventStartMs;
      const gross = calculateRefund(loaded, loaded.tickets, now);
      const net = netRefund(loaded, loaded.tickets, now);
      // One assertion covering both sides: money moves if and only if the window is open.
      expect({ now, gross, net }).toEqual({
        now,
        gross: open ? 10_000 : 0,
        net: open ? 9_800 : 0,
      });
    }
  });

  it("does not pay a customer whose order was booked before the event and cancelled after it", async () => {
    // The whole money path in one go, against the real database: an order is taken,
    // stored, read back, and the refund is requested late. The exactly-once guard
    // has nothing to say about this — it happily lets the one permitted refund
    // through — so the amount is the only thing standing between the platform and
    // paying out for a show the customer already attended.
    const id = await saveOrder(db, anOrder({ totalCents: 25_000, tickets: 5 }));
    const loaded = (await getOrder(db, id))!;
    const afterTheShow = loaded.eventStartMs + 2 * HOUR;

    const won = await markRefunded(db, id);
    const paidOut = won ? netRefund(loaded, loaded.tickets, afterTheShow) : 0;

    expect(won).toBe(true);
    expect(await isRefunded(db, id)).toBe(true);
    expect(paidOut).toBe(0);
  });

  it("keeps a migrated legacy row on the same side of the gate", async () => {
    // Rows written before any of the column widenings (src/orders-repo.ts:32-41)
    // reach the money path through the migration, and the gate has to hold for them too.
    await db.query(`DROP TABLE IF EXISTS orders`);
    await db.query(`
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        total_cents INTEGER NOT NULL,
        tickets INTEGER NOT NULL,
        discount_percent INTEGER NOT NULL,
        event_start_ms BIGINT NOT NULL
      )
    `);
    const inserted = await db.query(
      `INSERT INTO orders (total_cents, tickets, discount_percent, event_start_ms)
       VALUES (10000, 4, 0, $1) RETURNING id`,
      [EVENT_START],
    );
    const id = inserted.rows[0].id as number;

    await initSchema(db);
    const loaded = (await getOrder(db, id))!;

    expect(calculateRefund(loaded, 4, loaded.eventStartMs - HOUR)).toBe(10_000);
    expect(calculateRefund(loaded, 4, loaded.eventStartMs)).toBe(0);
    expect(netRefund(loaded, 4, loaded.eventStartMs + HOUR)).toBe(0);
  });
});
