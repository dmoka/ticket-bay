// Integration lane, round 2: the time gate, verified where only this lane can look.
//
// Round 1 (tests/integration/refund-time-gate.integration-lane.test.ts) established
// that the window closes at `eventStartMs`. This file assumes that and asks the three
// questions that need a REAL database to answer at all:
//
//   1. The gate compares `nowMs` against an instant that came back out of a
//      DOUBLE PRECISION column (src/orders-repo.ts:27) through the pg driver's TEXT
//      protocol. So the boundary that matters is not the literal in the test, it is the
//      double the database returned. These sweep several ULPs either side of the LOADED
//      value and pin that the flip happens on it exactly — for whole-millisecond,
//      fractional, pre-epoch and epoch starts.
//   2. Rows written before the column widenings (src/orders-repo.ts:35-41) reach the
//      same money path through the migration. A legacy row and a native row with the
//      same start must land on the SAME SIDE of the gate at every clock — asserted as an
//      equality between the two rows, not as two separately-hardcoded constants.
//   3. The exactly-once guard (`markRefunded`, src/orders-repo.ts:89) and the gate are
//      two independent protections against paying twice / paying late. After the event
//      no money may move no matter which way the guard falls — including if the guard is
//      bypassed entirely. Before the event the guard must still do its own job, so this
//      also shows the composition is not vacuously zero.
//
// Source is read-only for this lane; everything below is a test.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { initSchema, saveOrder, getOrder, markRefunded, isRefunded } from "../../src/orders-repo";
import { calculateRefund, netRefund, refundFee, Order } from "../../src/refund";

let container: StartedPostgreSqlContainer;
let db: Client;
// A second and third connection, so "concurrent" below means real concurrent
// transactions against real row locks and not two queries queued on one socket.
let racerA: Client;
let racerB: Client;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const uri = container.getConnectionUri();
  db = new Client({ connectionString: uri });
  racerA = new Client({ connectionString: uri });
  racerB = new Client({ connectionString: uri });
  await Promise.all([db.connect(), racerA.connect(), racerB.connect()]);
}, 120000);

afterAll(async () => {
  await Promise.all([db?.end(), racerA?.end(), racerB?.end()]);
  await container?.stop();
});

// Fresh schema for every test — no row and no refunded_at survives into the next one.
beforeEach(async () => {
  await db.query(`DROP TABLE IF EXISTS orders`);
  await initSchema(db);
});

const EVENT_START = 1_800_000_000_000; // 2027-01-15
const PRE_EPOCH = -2_208_988_800_000; // 1900-01-01
const SECOND = 1_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const anOrder = (over: Partial<Order> = {}): Order => ({
  totalCents: 10_000,
  tickets: 4,
  discountPercent: 0,
  eventStartMs: EVENT_START,
  ...over,
});
// The full-order amounts for `anOrder()`: 10000 gross, 2% fee = 200, so 9800 net.
const GROSS = 10_000;
const NET = 9_800;

// ---------------------------------------------------------------------------
// Helpers, and their own tests.
//
// Every claim in this file is a claim about WHICH SIDE of a boundary a clock falls
// on, so the functions that produce "one step below the start" and "one step above
// it" are load-bearing: a helper that stepped the wrong way, or skipped a value,
// would aim every assertion below at the wrong side and report a defect that is not
// there. IEEE-754 doubles are sign-MAGNITUDE, so incrementing the bit pattern of a
// negative double moves DOWN, and the neighbourhood of zero crosses a sign bit. The
// domain reaches both: src/refund.ts:42 admits any finite instant and this file
// stores a 1900 start and the epoch itself. So the steps are verified over the whole
// census they are fed, negatives and zero included, before anything trusts them.
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

/** The bit pattern of a double, for saying "the same double" without ambiguity. */
function bitsHex(v: number): string {
  return bitsOf(v).toString(16).padStart(16, "0");
}

/** The next double strictly above `v`. */
function nextAfter(v: number): number {
  if (!Number.isFinite(v)) throw new RangeError("nextAfter needs a finite value");
  if (v === 0) return Number.MIN_VALUE; // +0 and -0 both step up to the smallest denormal
  const stepped = v > 0 ? fromBits(bitsOf(v) + 1n) : fromBits(bitsOf(v) - 1n);
  // Stepping up out of the negative denormals lands on IEEE's -0. Nothing downstream
  // can tell -0 from +0 (src/refund.ts compares with `<` and `>=`, and the driver
  // already collapses -0 to 0 on the way into the database — asserted at
  // tests/integration/orders-storage.test.ts:205), so hand back the positive zero
  // rather than a clock that is equal to another but not identical to it.
  return stepped === 0 ? 0 : stepped;
}

/** The next double strictly below `v`. */
function nextBefore(v: number): number {
  if (!Number.isFinite(v)) throw new RangeError("nextBefore needs a finite value");
  if (v === 0) return -Number.MIN_VALUE;
  return v > 0 ? fromBits(bitsOf(v) - 1n) : fromBits(bitsOf(v) + 1n);
}

/** `n` representable steps from `v` — up for positive `n`, down for negative. */
function stepUlps(v: number, n: number): number {
  let out = v;
  for (let i = 0; i < Math.abs(n); i++) out = n > 0 ? nextAfter(out) : nextBefore(out);
  return out;
}

// Every instant this file uses, plus the sign and magnitude boundaries a bit-twiddling
// step gets wrong.
const CENSUS: [string, number][] = [
  ["the event start", EVENT_START],
  ["a fractional event start", EVENT_START + 0.5],
  ["a start that is not a round millisecond", EVENT_START + 0.4],
  ["zero, the epoch", 0],
  ["a pre-epoch start (1900)", PRE_EPOCH],
  ["a negative fractional start", PRE_EPOCH - 0.5],
  ["one", 1],
  ["minus one", -1],
  ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
  ["minus MAX_SAFE_INTEGER", -Number.MAX_SAFE_INTEGER],
  ["MIN_VALUE, the smallest denormal", Number.MIN_VALUE],
  ["minus MIN_VALUE", -Number.MIN_VALUE],
  ["twice MIN_VALUE", 2 * Number.MIN_VALUE],
  ["minus twice MIN_VALUE", -2 * Number.MIN_VALUE],
  ["EPSILON", Number.EPSILON],
];

const STEPS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];

describe("the clock helpers this file relies on", () => {
  it.each(CENSUS)("steps strictly up and strictly down from %s", (_label, v) => {
    expect(nextAfter(v)).toBeGreaterThan(v);
    expect(nextBefore(v)).toBeLessThan(v);
    expect(Number.isFinite(nextAfter(v))).toBe(true);
    expect(Number.isFinite(nextBefore(v))).toBe(true);
  });

  it.each(CENSUS)("steps back to exactly where it started from %s", (_label, v) => {
    expect(nextBefore(nextAfter(v))).toBe(v);
    expect(nextAfter(nextBefore(v))).toBe(v);
  });

  it.each(CENSUS)("leaves no double between %s and its neighbours", (_label, v) => {
    // The midpoint of two ADJACENT doubles is not representable and rounds to one of
    // the ends. A skipped value would make the midpoint a third distinct double.
    const up = (v + nextAfter(v)) / 2;
    expect(up === v || up === nextAfter(v)).toBe(true);
    const down = (v + nextBefore(v)) / 2;
    expect(down === v || down === nextBefore(v)).toBe(true);
  });

  it.each(CENSUS)("walks %s monotonically and reversibly, several steps out", (_label, v) => {
    const walked = STEPS.map((n) => stepUlps(v, n));
    for (let i = 1; i < walked.length; i++) {
      expect(walked[i]).toBeGreaterThan(walked[i - 1]);
    }
    expect(stepUlps(v, 0)).toBe(v);
    expect(stepUlps(v, 1)).toBe(nextAfter(v));
    expect(stepUlps(v, -1)).toBe(nextBefore(v));
    for (const n of STEPS) {
      // Four steps out and four back, through the sign change at zero for the
      // denormal entries, has to land on the value it started from.
      expect(stepUlps(stepUlps(v, n), -n)).toBe(v);
      expect(Object.is(stepUlps(v, n), -0)).toBe(false);
    }
  });

  it("matches the steps that are known constants, independently of the bit maths", () => {
    expect(nextAfter(1)).toBe(1 + Number.EPSILON);
    expect(nextBefore(1)).toBe(1 - Number.EPSILON / 2);
    expect(nextAfter(0)).toBe(Number.MIN_VALUE);
    expect(nextBefore(0)).toBe(-Number.MIN_VALUE);
    expect(nextBefore(Number.MIN_VALUE)).toBe(0);
    expect(stepUlps(0, 3)).toBe(3 * Number.MIN_VALUE);
    expect(stepUlps(0, -3)).toBe(-3 * Number.MIN_VALUE);
    // Above 2^52 the gap between doubles is exactly 1, so stepping is integer maths.
    expect(nextAfter(Number.MAX_SAFE_INTEGER)).toBe(2 ** 53);
    expect(nextBefore(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(stepUlps(Number.MAX_SAFE_INTEGER, -4)).toBe(Number.MAX_SAFE_INTEGER - 4);
    expect(nextAfter(-Number.MAX_SAFE_INTEGER)).toBe(-Number.MAX_SAFE_INTEGER + 1);
    expect(nextBefore(-Number.MAX_SAFE_INTEGER)).toBe(-(2 ** 53));
  });

  it("refuses a clock it cannot step, instead of returning a wrong one", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => nextAfter(bad)).toThrow(RangeError);
      expect(() => nextBefore(bad)).toThrow(RangeError);
    }
  });

  it("distinguishes doubles that print the same, so 'the same instant' means the same bits", () => {
    expect(bitsHex(EVENT_START)).not.toBe(bitsHex(nextAfter(EVENT_START)));
    expect(bitsHex(EVENT_START)).toBe(bitsHex(1_800_000_000_000));
    // The two zeros print identically and compare equal; only the bits separate them.
    expect(bitsHex(0)).not.toBe(bitsHex(-0));
  });

  it("steps by less than a millisecond at every event start this file stores", () => {
    // Not a property of the helper — a statement that the sweeps below really do probe
    // the boundary tightly, rather than jumping a whole millisecond past it.
    for (const start of [EVENT_START, EVENT_START + 0.5, EVENT_START + 0.4, PRE_EPOCH]) {
      const gap = nextAfter(start) - start;
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(1);
    }
  });
});

// ---------------------------------------------------------------------------

/** Persist an order and read it back, so every assertion runs on what the database returned. */
async function roundTrip(o: Order): Promise<Order> {
  const id = await saveOrder(db, o);
  const loaded = await getOrder(db, id);
  expect(loaded).not.toBeNull();
  return loaded!;
}

/**
 * Clocks packed tightly around `start`, plus coarse ones well either side.
 * Every value is derived from the instant handed in — which in the tests below is
 * always the instant the DATABASE returned, never the literal that was saved.
 */
function clocksAround(start: number): number[] {
  const tight = STEPS.map((n) => stepUlps(start, n));
  const coarse = [0.5, 1, SECOND, HOUR, DAY].flatMap((d) => [start - d, start + d]);
  return [...tight, ...coarse];
}

/** What the money path did at one clock, in a form a failure message can show whole. */
function payoutAt(order: Order, cancelled: number, now: number) {
  return {
    gross: calculateRefund(order, cancelled, now),
    net: netRefund(order, cancelled, now),
  };
}

describe("the gate flips on the instant the database returned (real Postgres)", () => {
  const STARTS: [string, number][] = [
    ["a whole-millisecond start", EVENT_START],
    ["a half-millisecond start", EVENT_START + 0.5],
    ["a start that is not a round millisecond", EVENT_START + 0.4],
    ["the very next double above a whole-millisecond start", nextAfter(EVENT_START)],
    ["a pre-epoch start (1900)", PRE_EPOCH],
    ["a fractional pre-epoch start", PRE_EPOCH - 0.5],
    ["the epoch itself", 0],
  ];

  it.each(STARTS)("returns %s bit for bit, so the gate compares against the stored instant", async (_label, eventStartMs) => {
    // Everything after this test is about which side of the loaded value a clock falls
    // on. That is only interesting if the loaded value is the same double that was
    // stored — said in bits, because `toBe` cannot separate 0 from -0 and `toBeCloseTo`
    // would hide exactly the drift that would move the boundary.
    const loaded = await roundTrip(anOrder({ eventStartMs }));

    expect(bitsHex(loaded.eventStartMs)).toBe(bitsHex(eventStartMs));
  });

  it.each(STARTS)("pays if and only if the clock is strictly below %s, swept ULP by ULP", async (_label, eventStartMs) => {
    const loaded = await roundTrip(anOrder({ eventStartMs }));
    const start = loaded.eventStartMs; // the database's value, not the literal above

    for (const now of clocksAround(start)) {
      const open = now < start;
      expect({ now, ...payoutAt(loaded, loaded.tickets, now) }).toEqual({
        now,
        gross: open ? GROSS : 0,
        net: open ? NET : 0,
      });
    }
  });

  it.each(STARTS)("puts the flip on %s exactly — the step below pays in full, the instant itself pays nothing", async (_label, eventStartMs) => {
    // The sweep above would still pass if the gate sat one representable step out in
    // either direction and every probe agreed with it. This names the two adjacent
    // doubles the rule is actually about.
    const loaded = await roundTrip(anOrder({ eventStartMs }));
    const start = loaded.eventStartMs;
    const lastOpen = nextBefore(start);

    expect(payoutAt(loaded, loaded.tickets, lastOpen)).toEqual({ gross: GROSS, net: NET });
    expect(payoutAt(loaded, loaded.tickets, start)).toEqual({ gross: 0, net: 0 });
    // Nothing representable sits between them, so the gate cannot be a step off in
    // either direction and still satisfy both lines above.
    expect(nextAfter(lastOpen)).toBe(start);
  });

  it("treats a stored negative-zero start as the epoch, on both sides of the gate", async () => {
    // The driver serialises a parameter with String(-0) === "0", so a -0 start comes
    // back as +0 (tests/integration/orders-storage.test.ts:205). That is only harmless
    // if the gate lands identically either way — which is a claim about the gate, not
    // about storage, and belongs here.
    const loaded = await roundTrip(anOrder({ eventStartMs: -0 }));
    expect(bitsHex(loaded.eventStartMs)).toBe(bitsHex(0));

    expect(payoutAt(loaded, 4, -Number.MIN_VALUE)).toEqual({ gross: GROSS, net: NET });
    expect(payoutAt(loaded, 4, -0)).toEqual({ gross: 0, net: 0 });
    expect(payoutAt(loaded, 4, 0)).toEqual({ gross: 0, net: 0 });
    expect(payoutAt(loaded, 4, Number.MIN_VALUE)).toEqual({ gross: 0, net: 0 });
  });

  it("closes the window for every partial cancellation of a loaded order, not just the whole one", async () => {
    // A gate that only covered the full-order path would leave the piecemeal caller
    // described in src/refund.ts:19-27 paying out after the show.
    const loaded = await roundTrip(anOrder({ totalCents: 10_001, tickets: 3, eventStartMs: EVENT_START + 0.5 }));
    const start = loaded.eventStartMs;
    // 10001 cents over 3 tickets, rounded half up per src/refund.ts:71-77.
    const openShare = [0, 3_334, 6_667, 10_001];

    for (const cancelled of [0, 1, 2, 3]) {
      for (const now of [start, nextAfter(start), start + 1, start + DAY]) {
        expect({ cancelled, now, ...payoutAt(loaded, cancelled, now) }).toEqual({
          cancelled,
          now,
          gross: 0,
          net: 0,
        });
      }
      // Still paying its full share a step earlier, so the zeros above are the gate
      // closing and not an order that was worth nothing to begin with.
      expect(calculateRefund(loaded, cancelled, nextBefore(start))).toBe(openShare[cancelled]);
    }
  });

  it("pays nothing after the start on the largest order the schema can hold", async () => {
    // The bigger the order, the more a gate that leaked would cost. Said at the top of
    // the range calculateRefund admits (src/refund.ts:39), through the BIGINT money
    // column that comes back as a string (src/orders-repo.ts:77).
    const loaded = await roundTrip(anOrder({ totalCents: Number.MAX_SAFE_INTEGER, tickets: 3 }));
    expect(loaded.totalCents).toBe(Number.MAX_SAFE_INTEGER);
    const start = loaded.eventStartMs;

    expect(calculateRefund(loaded, 3, nextBefore(start))).toBe(Number.MAX_SAFE_INTEGER);
    for (const now of [start, nextAfter(start), start + DAY]) {
      expect(payoutAt(loaded, 3, now)).toEqual({ gross: 0, net: 0 });
    }
  });
});

describe("a migrated legacy row sits on the same side of the gate as a native one (real Postgres)", () => {
  /** A table exactly as it was before the four widenings in src/orders-repo.ts:35-41. */
  async function createLegacyTable(): Promise<void> {
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
  }

  async function insertLegacyRow(eventStartMs: number): Promise<number> {
    const r = await db.query(
      `INSERT INTO orders (total_cents, tickets, discount_percent, event_start_ms)
       VALUES (10000, 4, 0, $1) RETURNING id`,
      [eventStartMs],
    );
    return r.rows[0].id as number;
  }

  // Only starts a BIGINT column could hold — the legacy row could not have been
  // written with a fractional one.
  const LEGACY_STARTS: [string, number][] = [
    ["a whole-millisecond start", EVENT_START],
    ["a pre-epoch start (1900)", PRE_EPOCH],
    ["the epoch itself", 0],
  ];

  it.each(LEGACY_STARTS)("gives a legacy and a native row the identical gate for %s", async (_label, eventStartMs) => {
    await createLegacyTable();
    const legacyId = await insertLegacyRow(eventStartMs);

    await initSchema(db);
    const nativeId = await saveOrder(db, anOrder({ eventStartMs }));

    const legacy = (await getOrder(db, legacyId))!;
    const native = (await getOrder(db, nativeId))!;

    // Same instant, to the bit — a legacy row that came back a fraction of a
    // millisecond out would sit on the other side of the gate for clocks in between.
    expect(bitsHex(legacy.eventStartMs)).toBe(bitsHex(native.eventStartMs));
    expect(legacy).toEqual(native);

    // And the same money at every clock, asserted row against row rather than each
    // against a constant: whatever the gate does, it does the same thing to both.
    for (const now of clocksAround(native.eventStartMs)) {
      const l = payoutAt(legacy, legacy.tickets, now);
      const n = payoutAt(native, native.tickets, now);
      expect({ now, ...l }).toEqual({ now, ...n });
      // Not vacuous: both are on the side the clock says they should be on.
      expect({ now, ...l }).toEqual({
        now,
        gross: now < native.eventStartMs ? GROSS : 0,
        net: now < native.eventStartMs ? NET : 0,
      });
    }
  });

  it.each(LEGACY_STARTS)("does not move the gate for %s when the migration runs over an existing row", async (_label, eventStartMs) => {
    // The same row, read through the BIGINT column and then through the float8 one it
    // was widened into. BIGINT comes back from the driver as a STRING and float8 as a
    // number (src/orders-repo.ts:73-76), so this is two genuinely different decode
    // paths for one stored instant, and the gate has to fall the same way on both.
    await createLegacyTable();
    const id = await insertLegacyRow(eventStartMs);

    const before = (await getOrder(db, id))!;
    await initSchema(db);
    const after = (await getOrder(db, id))!;

    expect(bitsHex(before.eventStartMs)).toBe(bitsHex(after.eventStartMs));
    for (const now of clocksAround(after.eventStartMs)) {
      expect({ now, ...payoutAt(before, 4, now) }).toEqual({ now, ...payoutAt(after, 4, now) });
    }
    expect(payoutAt(after, 4, nextBefore(after.eventStartMs))).toEqual({ gross: GROSS, net: NET });
    expect(payoutAt(after, 4, after.eventStartMs)).toEqual({ gross: 0, net: 0 });
  });

  it("keeps a migrated legacy row unrefundable after its event, through the exactly-once guard too", async () => {
    await createLegacyTable();
    const id = await insertLegacyRow(EVENT_START);
    await initSchema(db);

    const loaded = (await getOrder(db, id))!;
    const won = await markRefunded(db, id);

    expect(won).toBe(true); // the guard has no objection — the amount is the only defence
    expect(await isRefunded(db, id)).toBe(true);
    expect(netRefund(loaded, loaded.tickets, loaded.eventStartMs + 2 * HOUR)).toBe(0);
  });
});

describe("the exactly-once guard and the gate compose (real Postgres)", () => {
  /**
   * One caller's attempt at a refund, the way server.ts:89-96 sequences it: claim the
   * order, then work out the money. Returns what this caller would actually pay out.
   */
  async function attemptRefund(client: Client, id: number, order: Order, now: number): Promise<number> {
    const won = await markRefunded(client, id);
    return won ? netRefund(order, order.tickets, now) : 0;
  }

  it("pays nothing after the event whichever way the guard falls", async () => {
    const id = await saveOrder(db, anOrder({ totalCents: 25_000, tickets: 5 }));
    const loaded = (await getOrder(db, id))!;
    const afterTheShow = loaded.eventStartMs + 2 * HOUR;

    // First caller wins the guard, second loses it, and a third asks about an order
    // that does not exist at all. Every branch of markRefunded, one after the other.
    const first = await attemptRefund(db, id, loaded, afterTheShow);
    const second = await attemptRefund(db, id, loaded, afterTheShow);
    const missing = await attemptRefund(db, 999_999, loaded, afterTheShow);

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(missing).toBe(0);
    // The guard still did its own job — it is the amount, not the guard, that is zero.
    expect(await isRefunded(db, id)).toBe(true);
  });

  it("pays nothing after the event even if the guard is bypassed entirely", async () => {
    // The strong form of the rule. `markRefunded` is a database row lock; a retry
    // loop, a replayed message or a second process that skipped the claim would call
    // the money path more than once. After the event that must still move nothing, so
    // the two protections are independent and the gate is not leaning on the guard.
    const id = await saveOrder(db, anOrder({ totalCents: 25_000, tickets: 5 }));
    const loaded = (await getOrder(db, id))!;

    const unguarded = [
      loaded.eventStartMs,
      nextAfter(loaded.eventStartMs),
      loaded.eventStartMs + 1,
      loaded.eventStartMs + DAY,
    ].map((now) => netRefund(loaded, loaded.tickets, now));

    expect(unguarded).toEqual([0, 0, 0, 0]);
    expect(unguarded.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("moves no money when eight real concurrent callers race for a post-event refund", async () => {
    const id = await saveOrder(db, anOrder({ totalCents: 25_000, tickets: 5 }));
    const loaded = (await getOrder(db, id))!;
    const afterTheShow = loaded.eventStartMs + 2 * HOUR;
    const clients = [db, racerA, racerB];

    const payouts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => attemptRefund(clients[i % clients.length], id, loaded, afterTheShow)),
    );

    // Exactly one caller won the guard, and the total that left the platform is zero.
    expect(await isRefunded(db, id)).toBe(true);
    expect(payouts).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(payouts.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("still lets exactly one of eight concurrent callers be paid before the event", async () => {
    // The mirror, and the reason none of the zeros above are vacuous: with the window
    // open the guard alone decides, and it pays one caller once. If this went to zero
    // the gate would be closing early and stranding customers who cancelled in time.
    const id = await saveOrder(db, anOrder());
    const loaded = (await getOrder(db, id))!;
    const beforeTheShow = nextBefore(loaded.eventStartMs);
    const clients = [db, racerA, racerB];

    const payouts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => attemptRefund(clients[i % clients.length], id, loaded, beforeTheShow)),
    );

    expect(payouts.filter((p) => p === NET)).toHaveLength(1);
    expect(payouts.filter((p) => p === 0)).toHaveLength(7);
    expect(payouts.reduce((a, b) => a + b, 0)).toBe(NET);
    expect(await isRefunded(db, id)).toBe(true);
  });

  it("does not let a clock that crosses the start mid-race pay twice, or pay late", async () => {
    // A refund claimed just before the start and a retry that lands just after it —
    // the ordering the guard and the gate have to survive together. One payout, taken
    // from the open side; nothing at all from the closed side.
    const id = await saveOrder(db, anOrder());
    const loaded = (await getOrder(db, id))!;

    const early = await attemptRefund(db, id, loaded, nextBefore(loaded.eventStartMs));
    const late = await attemptRefund(racerA, id, loaded, loaded.eventStartMs);
    const later = await attemptRefund(racerB, id, loaded, loaded.eventStartMs + DAY);

    expect([early, late, later]).toEqual([NET, 0, 0]);
    expect(early + late + later).toBe(NET);
    expect(early).toBeLessThanOrEqual(loaded.totalCents);
  });

  it("marks a post-event order refunded without paying, so the record and the money agree", async () => {
    // server.ts:94-96 flags the order spent whether or not the refund was worth
    // anything ("the order still exists, it is just spent"). The row must therefore be
    // claimable exactly once even when the payout is zero — otherwise a customer whose
    // late cancellation paid nothing could keep re-submitting it.
    const id = await saveOrder(db, anOrder());
    const loaded = (await getOrder(db, id))!;
    const afterTheShow = loaded.eventStartMs + HOUR;

    expect(await isRefunded(db, id)).toBe(false);
    expect(await attemptRefund(db, id, loaded, afterTheShow)).toBe(0);
    expect(await isRefunded(db, id)).toBe(true);
    expect(await markRefunded(db, id)).toBe(false);
    // And a later attempt is still worth nothing, whichever way it is computed.
    expect(await attemptRefund(db, id, loaded, afterTheShow)).toBe(0);
    expect(netRefund(loaded, loaded.tickets, afterTheShow)).toBe(0);
  });

  it("never pays more than was taken, on either side of the gate, across many orders", async () => {
    // The invariant the whole feature exists to protect, over a spread of orders in one
    // real database: refund at most what was paid, and nothing at all once the event
    // has started.
    const orders: Order[] = [
      anOrder(),
      anOrder({ totalCents: 150, tickets: 300 }),
      anOrder({ totalCents: 10_001, tickets: 3 }),
      anOrder({ totalCents: 0, tickets: 1 }),
      anOrder({ totalCents: 99, tickets: 1, eventStartMs: PRE_EPOCH }),
      anOrder({ totalCents: Number.MAX_SAFE_INTEGER, tickets: 7, eventStartMs: EVENT_START + 0.5 }),
    ];

    for (const o of orders) {
      const id = await saveOrder(db, o);
      const loaded = (await getOrder(db, id))!;
      const start = loaded.eventStartMs;

      for (const now of clocksAround(start)) {
        const { gross, net } = payoutAt(loaded, loaded.tickets, now);
        expect(gross).toBeLessThanOrEqual(loaded.totalCents);
        expect(net).toBeLessThanOrEqual(gross);
        expect(net).toBeGreaterThanOrEqual(0);
        if (now >= start) expect({ now, gross, net }).toEqual({ now, gross: 0, net: 0 });
      }
    }
  });
});

describe("a row the gate cannot judge never pays (real Postgres)", () => {
  // float8 has encodings INTEGER and BIGINT did not: NaN and ±Infinity. saveOrder
  // refuses them (src/orders-repo.ts:52-59), but the widened column can still hold one
  // written by hand, by an older binary, or by a migration — and a NaN start slips past
  // BOTH of the gate's comparisons, because `NaN >= x` and `NaN < x` are equally false.
  // The only thing standing between a corrupted row and a full payout is the finite
  // check at src/refund.ts:42.
  const CORRUPT: [string, string][] = [
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["-Infinity", "-Infinity"],
  ];

  async function insertRawStart(literal: string): Promise<number> {
    const r = await db.query(
      `INSERT INTO orders (total_cents, tickets, discount_percent, event_start_ms)
       VALUES (10000, 4, 0, $1::float8) RETURNING id`,
      [literal],
    );
    return r.rows[0].id as number;
  }

  it.each(CORRUPT)("refuses to price an order whose stored start is %s, rather than paying it out", async (_label, literal) => {
    const id = await insertRawStart(literal);
    const loaded = (await getOrder(db, id))!;

    // The database really did hand back a non-finite double — this is not a literal
    // typed into the test.
    expect(Number.isFinite(loaded.eventStartMs)).toBe(false);
    for (const now of [EVENT_START - DAY, EVENT_START, EVENT_START + DAY, 0]) {
      expect(() => calculateRefund(loaded, loaded.tickets, now)).toThrow(RangeError);
      expect(() => netRefund(loaded, loaded.tickets, now)).toThrow(RangeError);
    }
  });

  it("refuses to price a real stored order against a broken clock, rather than paying it out", async () => {
    // The other half of the same hazard, on a row that is perfectly good: the gate has
    // two operands and either one can be non-finite. A clock that is NaN fails BOTH
    // `nowMs >= eventStartMs` and `nowMs < eventStartMs`, so without the check at
    // src/refund.ts:47 a missing or broken clock falls straight through the closed
    // window into a full payout — the worst possible default.
    const loaded = await roundTrip(anOrder());
    expect(payoutAt(loaded, 4, loaded.eventStartMs - HOUR)).toEqual({ gross: GROSS, net: NET });

    for (const broken of [NaN, Infinity, -Infinity]) {
      expect(() => calculateRefund(loaded, loaded.tickets, broken)).toThrow(RangeError);
      expect(() => netRefund(loaded, loaded.tickets, broken)).toThrow(RangeError);
    }
  });

  it("keeps the fee at zero for every non-finite amount a float8 column can return", async () => {
    // refundFee is the last step before the platform keeps money. Fed a non-finite
    // amount it must keep nothing: without the finite check (src/refund.ts:85) NaN
    // slips past every comparison and collects the 50-cent minimum, and Infinity
    // collects an infinite fee. The values below came out of the database.
    const r = await db.query(
      `SELECT 'NaN'::float8 AS nan, 'Infinity'::float8 AS inf, '-Infinity'::float8 AS neg`,
    );
    const { nan, inf, neg } = r.rows[0];
    expect([Number.isNaN(nan), inf, neg]).toEqual([true, Infinity, -Infinity]);

    for (const amount of [nan, inf, neg]) {
      expect(refundFee(amount)).toBe(0);
    }
    // Still charging the real fee on real amounts, so the zeros above are the guard
    // and not a fee that stopped working.
    expect(refundFee(GROSS)).toBe(200);
    expect(refundFee(100)).toBe(50);
  });
});
