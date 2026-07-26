// Storage fidelity for the money columns against REAL Postgres (Testcontainers).
//
// src/orders-repo.ts:9-13 justifies the column type as a domain requirement:
//   "BIGINT, not INTEGER: calculateRefund admits totals up to
//    Number.MAX_SAFE_INTEGER, and INT4 tops out at 2147483647."
//
// The existing coverage stops at INT4 max (tests/integration/refund-persistence.test.ts:146)
// and the one test that goes past it only asserts inside an `if` that a rejected insert
// skips, so the widened column is never actually exercised at the size that motivated it.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { initSchema, saveOrder, getOrder } from "../../src/orders-repo";
import { calculateRefund, Order } from "../../src/refund";

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

beforeEach(async () => {
  await db.query(`DROP TABLE IF EXISTS orders`);
  await initSchema(db);
});

async function roundTrip(o: Order): Promise<Order> {
  const id = await saveOrder(db, o);
  const loaded = await getOrder(db, id);
  expect(loaded).not.toBeNull();
  return loaded!;
}

const EVENT_START = 1_800_000_000_000;
const HOUR = 3_600_000;

describe("the money column holds every total the domain admits (real Postgres)", () => {
  it("stores total_cents as BIGINT, not INT4", async () => {
    await saveOrder(db, { totalCents: 1, tickets: 1, discountPercent: 0, eventStartMs: EVENT_START });
    const r = await db.query(`SELECT pg_typeof(total_cents)::text AS t FROM orders LIMIT 1`);

    expect(r.rows[0].t).toBe("bigint");
  });

  it("round-trips the largest total calculateRefund accepts, without loss", async () => {
    const order = {
      totalCents: Number.MAX_SAFE_INTEGER,
      tickets: 3,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    };
    const loaded = await roundTrip(order);

    expect(loaded.totalCents).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(loaded.totalCents)).toBe(true);
    expect(loaded).toEqual(order);
  });

  it("refunds a total that overflows INT4 without a driver error", async () => {
    // Straight past the old INT4 ceiling, unconditionally — an insert that throws
    // here is a failure, not an acceptable outcome.
    const loaded = await roundTrip({
      totalCents: 3_000_000_000,
      tickets: 2,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    expect(loaded.totalCents).toBe(3_000_000_000);
    expect(calculateRefund(loaded, 2, loaded.eventStartMs - HOUR)).toBe(3_000_000_000);
  });

  it("widens a legacy INT4 money column, and then actually holds a bigger total", async () => {
    // src/orders-repo.ts:22-24 carries a migration for "databases created while
    // total_cents was still INT4". The existing migration test
    // (tests/integration/refund-idempotency.test.ts:177) runs initSchema over a legacy
    // table but only ever stores 10000, so deleting the ALTER would not fail anything.
    // The point of the migration is the capacity it buys, so assert the capacity.
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

    await initSchema(db);

    const t = await db.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'orders' AND column_name = 'total_cents'`,
    );
    expect(t.rows[0].data_type).toBe("bigint");

    const loaded = await roundTrip({
      totalCents: Number.MAX_SAFE_INTEGER,
      tickets: 3,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });
    expect(loaded.totalCents).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("keeps the exact-share arithmetic exact on a total that overflows float multiply", async () => {
    // src/refund.ts:59 warns the multiply exceeds 2^53 in floating point at these
    // sizes and can return a cent more than was paid. BigInt must keep it exact.
    const loaded = await roundTrip({
      totalCents: Number.MAX_SAFE_INTEGER,
      tickets: 3,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });
    const before = loaded.eventStartMs - HOUR;

    expect(calculateRefund(loaded, 3, before)).toBe(Number.MAX_SAFE_INTEGER);
    expect(calculateRefund(loaded, 1, before)).toBeLessThanOrEqual(loaded.totalCents);
    expect(calculateRefund(loaded, 2, before)).toBeLessThanOrEqual(loaded.totalCents);
  });
});

/** The next representable double above `v` — the tightest precision probe there is. */
function nextUp(v: number): number {
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = v;
  const bits = new BigUint64Array(buf);
  bits[0] += 1n;
  return new Float64Array(buf)[0];
}

// discount_percent and event_start_ms are DOUBLE PRECISION (src/orders-repo.ts:23-24).
// Widening a column is only safe if it loses nothing that the narrower one kept, and a
// float column is the obvious place for that to go quietly wrong. It does not go wrong
// here, and this says so at the boundaries rather than on comfortable middle values:
// Postgres DOUBLE PRECISION is the same IEEE-754 binary64 a JS number already is, and
// Postgres 12+ writes floats back as the shortest text that reparses to the same double,
// so the round trip is bit-exact for every finite value the domain can express.
describe("the widened float columns lose nothing (real Postgres)", () => {
  const EXACT: [string, number][] = [
    ["MAX_SAFE_INTEGER", Number.MAX_SAFE_INTEGER],
    ["2^53, one past the safe range", 2 ** 53],
    ["2^60, far above 2^53", 2 ** 60],
    ["MAX_VALUE", Number.MAX_VALUE],
    ["MIN_VALUE, a denormal", Number.MIN_VALUE],
    ["EPSILON", Number.EPSILON],
    ["a pre-epoch start (1900)", -2_208_988_800_000],
    ["a negative MAX_SAFE_INTEGER", -Number.MAX_SAFE_INTEGER],
    ["a half-millisecond start", EVENT_START + 0.5],
    ["a start that is not a round millisecond", EVENT_START + 0.4],
    ["the very next double above the event start", nextUp(EVENT_START)],
    ["the very next double below MAX_SAFE_INTEGER", nextUp(Number.MAX_SAFE_INTEGER - 2)],
    ["0.1, which has no exact binary form", 0.1],
    ["one third", 1 / 3],
  ];

  it.each(EXACT)("round-trips %s as an event start, bit for bit", async (_label, eventStartMs) => {
    const loaded = await roundTrip({ totalCents: 10_000, tickets: 4, discountPercent: 0, eventStartMs });

    // Object.is, not toBe on a tolerance: the question is whether a bit was lost.
    expect(Object.is(loaded.eventStartMs, eventStartMs)).toBe(true);
  });

  const DISCOUNTS: [string, number][] = [
    ["a third off", 33.33],
    ["a half percent step", 12.5],
    ["one third", 1 / 3],
    ["0.1", 0.1],
    ["the whole hundred", 100],
    ["the next double above a third off", nextUp(33.33)],
    ["a hair under a hundred", 99.99999999999999],
  ];

  it.each(DISCOUNTS)("round-trips %s as a discount, bit for bit", async (_label, discountPercent) => {
    const loaded = await roundTrip({ totalCents: 10_000, tickets: 4, discountPercent, eventStartMs: EVENT_START });

    expect(Object.is(loaded.discountPercent, discountPercent)).toBe(true);
  });

  it("still stores the total as BIGINT, so the exact-cent column never became a float", async () => {
    // The widening was for the two informational columns. Money must not follow them:
    // float8 cannot hold every integer cent up to MAX_SAFE_INTEGER and BIGINT can.
    const t = await db.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'orders' AND column_name IN ('total_cents', 'discount_percent', 'event_start_ms')
       ORDER BY column_name`,
    );

    expect(t.rows).toEqual([
      { column_name: "discount_percent", data_type: "double precision" },
      { column_name: "event_start_ms", data_type: "double precision" },
      { column_name: "total_cents", data_type: "bigint" },
    ]);
  });

  it("returns a negative zero event start as a positive zero, which changes nothing", async () => {
    // The one value in the census that does not survive Object.is. It is lost in the
    // driver, which serialises a parameter with String(-0) === "0" before Postgres sees
    // it. Recorded rather than ignored, with the reason it costs nothing: every
    // comparison the refund path makes treats -0 and 0 identically.
    const loaded = await roundTrip({ totalCents: 10_000, tickets: 4, discountPercent: 0, eventStartMs: -0 });

    expect(loaded.eventStartMs).toBe(0);
    expect(Object.is(loaded.eventStartMs, -0)).toBe(false);
    // The refund maths cannot tell the difference either, which is why this is a
    // note and not a bug.
    expect(calculateRefund(loaded, 4, -1)).toBe(10_000);
  });
});

// The justification for the widened columns (src/orders-repo.ts:15-22) says "finite"
// twice: "any finite discount in 0..100" and "any finite event start". float8 is wider
// than that. Unlike BIGINT and INT4, it has its own encodings for Infinity and NaN and
// accepts them happily, so the column now admits values the stated domain excludes —
// and every one of them is an order calculateRefund refuses forever
// (src/refund.ts:42-44). That is the hazard src/booking.ts:28-32 names in as many
// words: "a booking that is paid for and permanently unrefundable".
describe("the widened columns do not admit orders the refund path refuses (real Postgres)", () => {
  const NON_FINITE: [string, number][] = [
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["NaN", NaN],
  ];

  it.each(NON_FINITE)("refuses to store %s as an event start", async (_label, eventStartMs) => {
    // Whether the refusal comes from a validator in saveOrder or a CHECK constraint on
    // the column is the implementer's call; this only asserts it does not silently succeed.
    await expect(
      saveOrder(db, { totalCents: 10_000, tickets: 4, discountPercent: 0, eventStartMs }),
    ).rejects.toThrow();
  });

  it.each(NON_FINITE)("refuses to store %s as a discount", async (_label, discountPercent) => {
    await expect(
      saveOrder(db, { totalCents: 10_000, tickets: 4, discountPercent, eventStartMs: EVENT_START }),
    ).rejects.toThrow();
  });

  it("leaves no row behind whose event start is not a real instant", async () => {
    // The cost stated as a table invariant rather than a type: money was taken for such
    // an order and no clock value will ever get it back. Asserted unconditionally — a
    // refused insert is the outcome this wants, so swallowing the rejection is the point,
    // and the count below is checked either way rather than inside an `if` that a
    // working implementation skips.
    for (const eventStartMs of [Infinity, -Infinity, NaN]) {
      await saveOrder(db, { totalCents: 10_000, tickets: 4, discountPercent: 0, eventStartMs }).catch(
        () => undefined,
      );
    }

    const r = await db.query(
      `SELECT count(*)::int AS n FROM orders
       WHERE event_start_ms IN ('Infinity', '-Infinity') OR event_start_ms = 'NaN'`,
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("tests the value itself, not what the value coerces to", async () => {
    // The guard is `Number.isFinite`, and the difference from the global `isFinite` is
    // load-bearing: the global coerces first, so isFinite("4") is true where
    // Number.isFinite("4") is false. Nothing in JavaScript stops a caller reaching
    // saveOrder with a non-number, and the rule the guard states (src/orders-repo.ts:45)
    // is that the domain is defined in finite NUMBERS.
    //
    // This does NOT make stringly-typed input a supported contract. It is not one, tsc
    // rejects every call below, and the casts are here to say so. What it pins is which
    // of the two functions does the work, so that simplifying the guard to the global
    // one fails here rather than quietly widening what reaches the driver. Each value
    // must produce the DOMAIN error — under the global isFinite these sail past the
    // guard and become whatever the driver decides, which is the failure mode this
    // whole fix existed to remove.
    const NOT_A_NUMBER: [string, unknown][] = [
      ["a numeric string", "4"],
      ["an empty string", ""],
      ["null", null],
      ["a boolean", true],
      ["a Date", new Date(EVENT_START)],
      ["an array", []],
    ];

    for (const [label, value] of NOT_A_NUMBER) {
      const order = { totalCents: 10_000, tickets: 4, discountPercent: 0, eventStartMs: value };
      await expect(saveOrder(db, order as unknown as Order), label).rejects.toThrow(RangeError);
    }
  });

  it("refuses with a domain error naming the field, not a raw driver error", async () => {
    // The point of catching this in saveOrder rather than at the column was to get a
    // domain error out of it (src/orders-repo.ts:45-51). A driver error would also
    // reject the row, so rejection alone does not prove the fix landed as intended.
    await expect(
      saveOrder(db, { totalCents: 10_000, tickets: 4, discountPercent: 0, eventStartMs: NaN }),
    ).rejects.toThrow(RangeError);
    await expect(
      saveOrder(db, { totalCents: 10_000, tickets: 4, discountPercent: 0, eventStartMs: NaN }),
    ).rejects.toThrow(/eventStartMs/);
    await expect(
      saveOrder(db, { totalCents: NaN, tickets: 4, discountPercent: 0, eventStartMs: EVENT_START }),
    ).rejects.toThrow(/totalCents/);
    await expect(
      saveOrder(db, { totalCents: 10_000, tickets: Infinity, discountPercent: 0, eventStartMs: EVENT_START }),
    ).rejects.toThrow(/tickets/);
    await expect(
      saveOrder(db, { totalCents: 10_000, tickets: 4, discountPercent: NaN, eventStartMs: EVENT_START }),
    ).rejects.toThrow(/discountPercent/);
  });
});

// A guard that rejects too much is its own defect. Out-of-range-but-finite was never
// the regression: a -5 or 500 discount stored fine as INT4 and stores fine as float8,
// and saveOrder has never been the place where the 0..100 domain is enforced
// (src/refund.ts:36-38 does that, when the money is computed). Each value below is one
// that persisted before the finite guard existed and must persist after it.
describe("the finite guard refuses nothing that used to work (real Postgres)", () => {
  const STILL_STORABLE: [string, Partial<Order>][] = [
    ["a negative discount", { discountPercent: -5 }],
    ["a discount above a hundred", { discountPercent: 500 }],
    ["an absurd but finite discount", { discountPercent: 1e300 }],
    ["a negative denormal discount", { discountPercent: -1e-320 }],
    ["a negative total", { totalCents: -1 }],
    ["a zero total", { totalCents: 0 }],
    ["a zero ticket count", { tickets: 0 }],
    ["a negative ticket count", { tickets: -1 }],
    ["a negative zero event start", { eventStartMs: -0 }],
    ["the largest finite event start", { eventStartMs: Number.MAX_VALUE }],
    ["a pre-epoch event start", { eventStartMs: -2_208_988_800_000 }],
  ];

  it.each(STILL_STORABLE)("still stores %s", async (_label, over) => {
    const order: Order = {
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START,
      ...over,
    };

    await expect(saveOrder(db, order)).resolves.toEqual(expect.any(Number));
  });

  it("still rejects the non-integer values the column always rejected", async () => {
    // The mirror of the census above: the guard must not have loosened either. These
    // die in the driver on a BIGINT column, exactly as they did before the guard.
    await expect(
      saveOrder(db, { totalCents: 100.5, tickets: 4, discountPercent: 0, eventStartMs: EVENT_START }),
    ).rejects.toThrow();
    await expect(
      saveOrder(db, { totalCents: 10_000, tickets: 4.6, discountPercent: 0, eventStartMs: EVENT_START }),
    ).rejects.toThrow();
  });
});

// tickets went INT4 -> BIGINT (src/orders-repo.ts:14-17). BIGINT is the column type
// that comes back from the driver as a STRING, so a widening here is also a decoding
// change, and getOrder now coerces it (src/orders-repo.ts:78). Both halves need saying.
describe("the ticket count holds every venue the domain admits (real Postgres)", () => {
  it("stores tickets as BIGINT, not INT4", async () => {
    await saveOrder(db, { totalCents: 1, tickets: 1, discountPercent: 0, eventStartMs: EVENT_START });
    const r = await db.query(`SELECT pg_typeof(tickets)::text AS t FROM orders LIMIT 1`);

    expect(r.rows[0].t).toBe("bigint");
  });

  it("returns the ticket count as a number, not the string BIGINT decodes to", async () => {
    // calculateRefund gates on Number.isInteger(order.tickets) (src/refund.ts:33), which
    // a string fails, so a missing coercion would make every widened order unrefundable.
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 3_000_000_000,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    expect(typeof loaded.tickets).toBe("number");
    expect(loaded.tickets).toBe(3_000_000_000);
    expect(Number.isInteger(loaded.tickets)).toBe(true);
  });

  it("round-trips ticket counts past the old INT4 ceiling, exactly", async () => {
    for (const tickets of [2_147_483_647, 2_147_483_648, 3_000_000_000, Number.MAX_SAFE_INTEGER, 2 ** 62]) {
      const loaded = await roundTrip({
        totalCents: 10_000,
        tickets,
        discountPercent: 0,
        eventStartMs: EVENT_START,
      });
      expect(Object.is(loaded.tickets, tickets)).toBe(true);
    }
  });

  it("prices a refund correctly on a ticket count that INT4 could never have held", async () => {
    // The capacity has to reach the money path, not just the column.
    const loaded = await roundTrip({
      totalCents: 3_000_000_000,
      tickets: 3_000_000_000,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    expect(calculateRefund(loaded, loaded.tickets, EVENT_START - HOUR)).toBe(3_000_000_000);
    expect(calculateRefund(loaded, 1, EVENT_START - HOUR)).toBe(1);
  });
});

describe("migrating a legacy integer-column table (real Postgres)", () => {
  /** A table as it was before any of the four widenings. */
  async function createLegacyTable(): Promise<number> {
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
    const r = await db.query(
      `INSERT INTO orders (total_cents, tickets, discount_percent, event_start_ms)
       VALUES (10000, 4, 10, $1) RETURNING id`,
      [EVENT_START],
    );
    return r.rows[0].id as number;
  }

  it("widens every column the domain outgrew", async () => {
    // One assertion per ALTER in initSchema (src/orders-repo.ts:35-41). Deleting any of
    // them fails here, which is the only reason this checks the catalogue at all.
    await createLegacyTable();

    await initSchema(db);

    const t = await db.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'orders'
         AND column_name IN ('total_cents', 'tickets', 'discount_percent', 'event_start_ms')
       ORDER BY column_name`,
    );
    expect(t.rows).toEqual([
      { column_name: "discount_percent", data_type: "double precision" },
      { column_name: "event_start_ms", data_type: "double precision" },
      { column_name: "tickets", data_type: "bigint" },
      { column_name: "total_cents", data_type: "bigint" },
    ]);
  });

  it("then stores the values the legacy columns could not hold", async () => {
    // The capacity is the whole point of the migration, so assert the capacity and not
    // just the DDL: on an unmigrated table every one of these dies in the driver.
    await createLegacyTable();

    await initSchema(db);

    const loaded = await roundTrip({
      totalCents: Number.MAX_SAFE_INTEGER,
      tickets: 3_000_000_000,
      discountPercent: 33.33,
      eventStartMs: EVENT_START + 0.5,
    });
    expect(loaded.totalCents).toBe(Number.MAX_SAFE_INTEGER);
    expect(loaded.tickets).toBe(3_000_000_000);
    expect(loaded.discountPercent).toBe(33.33);
    expect(loaded.eventStartMs).toBe(EVENT_START + 0.5);
  });

  it("leaves the rows that were already there readable and unchanged", async () => {
    const legacyId = await createLegacyTable();

    await initSchema(db);

    expect(await getOrder(db, legacyId)).toEqual({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 10,
      eventStartMs: EVENT_START,
    });
  });

  it("keeps a migrated legacy row refundable", async () => {
    const legacyId = await createLegacyTable();
    await initSchema(db);

    const loaded = (await getOrder(db, legacyId))!;

    expect(calculateRefund(loaded, 4, loaded.eventStartMs - HOUR)).toBe(10_000);
  });
});
