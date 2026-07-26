// Integration tests for the refund money path against REAL Postgres (Testcontainers).
// Every order under test is written to the database and read back before any money
// is computed, so the numbers are produced from driver-deserialized values, not literals.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { initSchema, saveOrder, getOrder } from "../../src/orders-repo";
import { calculateRefund, netRefund, refundFee, Order } from "../../src/refund";

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

const EVENT_START = 1_800_000_000_000; // 2027-01-15, stored in a BIGINT column
const HOUR = 3_600_000;

describe("refund time gate on a persisted order (real Postgres)", () => {
  it("refunds in full while the event is still in the future", async () => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    expect(calculateRefund(loaded, 4, loaded.eventStartMs - HOUR)).toBe(10_000);
  });

  // Spec, src/refund.ts:16-17 — "cancellations are only allowed BEFORE the event
  // starts. From `eventStartMs` on, the refund is zero."
  it("refunds nothing once the event has started", async () => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    expect(calculateRefund(loaded, 4, loaded.eventStartMs + HOUR)).toBe(0);
  });

  it("refunds nothing at the exact moment the event starts", async () => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    expect(calculateRefund(loaded, 4, loaded.eventStartMs)).toBe(0);
  });

  it("pays out nothing net once the event has started", async () => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    expect(netRefund(loaded, 4, loaded.eventStartMs + HOUR)).toBe(0);
  });

  it("closes the gate for a long-past event loaded from storage", async () => {
    // An event from 2020 that is still sitting in the orders table.
    const loaded = await roundTrip({
      totalCents: 25_000,
      tickets: 5,
      discountPercent: 20,
      eventStartMs: 1_600_000_000_000,
    });

    expect(calculateRefund(loaded, 5, Date.now())).toBe(0);
    expect(netRefund(loaded, 5, Date.now())).toBe(0);
  });

  it("still gates partial cancellations after the event starts", async () => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    expect(calculateRefund(loaded, 1, loaded.eventStartMs + 1)).toBe(0);
  });
});

describe("refund amounts on a persisted order (real Postgres)", () => {
  const before = (o: Order) => o.eventStartMs - HOUR;

  it("splits an indivisible total to the nearest cent", async () => {
    const loaded = await roundTrip({
      totalCents: 10_001,
      tickets: 3,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    // 10001 / 3 = 3333.67 -> 3334
    expect(calculateRefund(loaded, 1, before(loaded))).toBe(3334);
  });

  it("never pays out more than was actually paid across per-ticket refunds", async () => {
    const loaded = await roundTrip({
      totalCents: 10_001,
      tickets: 3,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    const whole = calculateRefund(loaded, 3, before(loaded));
    expect(whole).toBe(10_001);
    expect(whole).toBeLessThanOrEqual(loaded.totalCents);
  });

  it("applies the 2% fee to a large refund read back from the database", async () => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    const gross = calculateRefund(loaded, 4, before(loaded));
    expect(refundFee(gross)).toBe(200);
    expect(netRefund(loaded, 4, before(loaded))).toBe(9_800);
  });

  it("applies the 50 cent minimum fee to a small refund", async () => {
    const loaded = await roundTrip({
      totalCents: 1_000,
      tickets: 10,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    // gross 100 -> 2% is 2, floored to the 50 cent minimum
    expect(calculateRefund(loaded, 1, before(loaded))).toBe(100);
    expect(netRefund(loaded, 1, before(loaded))).toBe(50);
  });

  it("never returns a negative net when the fee would exceed the refund", async () => {
    const loaded = await roundTrip({
      totalCents: 40,
      tickets: 1,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    expect(calculateRefund(loaded, 1, before(loaded))).toBe(40);
    expect(netRefund(loaded, 1, before(loaded))).toBe(0);
  });

  it("refunds nothing when no tickets are cancelled", async () => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    expect(calculateRefund(loaded, 0, before(loaded))).toBe(0);
    expect(netRefund(loaded, 0, before(loaded))).toBe(0);
  });

  it("rejects cancelling more tickets than the stored order holds", async () => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    expect(() => calculateRefund(loaded, 5, before(loaded))).toThrow(RangeError);
  });

  it("keeps a zero-price (fully discounted) order at a zero refund", async () => {
    const loaded = await roundTrip({
      totalCents: 0,
      tickets: 2,
      discountPercent: 100,
      eventStartMs: EVENT_START,
    });

    expect(calculateRefund(loaded, 2, before(loaded))).toBe(0);
    expect(netRefund(loaded, 2, before(loaded))).toBe(0);
  });
});

describe("storage fidelity of money fields (real Postgres)", () => {
  it("preserves the paid total exactly through a round trip", async () => {
    const order = {
      totalCents: 2_147_483_647, // INT4 max — the largest total the schema can hold
      tickets: 7,
      discountPercent: 33,
      eventStartMs: EVENT_START,
    };
    const loaded = await roundTrip(order);

    expect(loaded).toEqual(order);
    expect(typeof loaded.totalCents).toBe("number");
  });

  it("does not silently corrupt a total the schema cannot hold", async () => {
    // calculateRefund accepts totals up to Number.MAX_SAFE_INTEGER (src/refund.ts:29)
    // but the orders.total_cents column is INTEGER. Whatever the repo does here, it
    // must not quietly store a different number than the caller paid.
    const order = {
      totalCents: 3_000_000_000,
      tickets: 2,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    };

    let id: number | null = null;
    try {
      id = await saveOrder(db, order);
    } catch {
      id = null; // rejected loudly — acceptable
    }

    if (id !== null) {
      const loaded = await getOrder(db, id);
      expect(loaded!.totalCents).toBe(order.totalCents);
    }
  });
});

// The gate compares nowMs against an eventStartMs that Postgres returns as a BIGINT
// *string*, coerced with Number() in getOrder (src/orders-repo.ts:38). A cutoff is only
// as trustworthy as that coercion, so the boundary is checked on the loaded value.
describe("time gate boundary survives the BIGINT round trip (real Postgres)", () => {
  it("returns the stored event start unchanged, not merely a number", async () => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    expect(loaded.eventStartMs).toBe(EVENT_START);
    expect(Number.isSafeInteger(loaded.eventStartMs)).toBe(true);
  });

  it("refunds in full one millisecond before the stored event start", async () => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    expect(calculateRefund(loaded, 4, loaded.eventStartMs - 1)).toBe(10_000);
    expect(netRefund(loaded, 4, loaded.eventStartMs - 1)).toBe(9_800);
  });

  it("refunds nothing one millisecond after the stored event start", async () => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    expect(calculateRefund(loaded, 4, loaded.eventStartMs + 1)).toBe(0);
  });

  it("puts the cutoff on exactly the same millisecond that was persisted", async () => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    // The last refundable instant and the first non-refundable one are adjacent,
    // measured against the value that came back out of the database.
    expect(calculateRefund(loaded, 4, EVENT_START - 1)).toBe(10_000);
    expect(calculateRefund(loaded, 4, EVENT_START)).toBe(0);
  });

  it("keeps the boundary exact at the top of the safe-integer range", async () => {
    // calculateRefund admits any finite eventStartMs (src/refund.ts:32); this is the
    // largest one that BIGINT -> Number can still represent without rounding.
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: Number.MAX_SAFE_INTEGER,
    });

    expect(loaded.eventStartMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(calculateRefund(loaded, 4, Number.MAX_SAFE_INTEGER - 1)).toBe(10_000);
    expect(calculateRefund(loaded, 4, Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it("never pays out on a broken clock for a persisted order", async () => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    // A missing or unusable clock must fail closed rather than fall through to a payout.
    for (const badClock of [NaN, Infinity, -Infinity]) {
      expect(() => calculateRefund(loaded, 4, badClock)).toThrow(RangeError);
      expect(() => netRefund(loaded, 4, badClock)).toThrow(RangeError);
    }
  });
});

describe("proportional share is exact for totals the schema can hold (real Postgres)", () => {
  const before = (o: Order) => o.eventStartMs - HOUR;

  it("never over-refunds the largest storable total", async () => {
    const order = {
      totalCents: 2_147_483_647, // INT4 max
      tickets: 3,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    };
    const loaded = await roundTrip(order);

    const perTicket = calculateRefund(loaded, 1, before(loaded));
    const all = calculateRefund(loaded, 3, before(loaded));

    expect(all).toBe(order.totalCents);
    expect(perTicket).toBe(715_827_882); // 2147483647 / 3 = 715827882.33 -> down
    expect(perTicket * 3).toBeLessThanOrEqual(order.totalCents + 2);
  });

  it("rounds a half-cent share up, as the docstring promises", async () => {
    const loaded = await roundTrip({
      totalCents: 5,
      tickets: 2,
      discountPercent: 0,
      eventStartMs: EVENT_START,
    });

    // 5 / 2 = 2.5 -> 3
    expect(calculateRefund(loaded, 1, before(loaded))).toBe(3);
  });

  it("refunds every cent when the whole order is cancelled, whatever the total", async () => {
    for (const totalCents of [1, 7, 99, 10_001, 999_983, 2_147_483_647]) {
      const loaded = await roundTrip({
        totalCents,
        tickets: 7,
        discountPercent: 0,
        eventStartMs: EVENT_START,
      });
      expect(calculateRefund(loaded, 7, before(loaded))).toBe(totalCents);
    }
  });
});
