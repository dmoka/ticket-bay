// Adversarial lane: does an order survive a trip through the database unchanged?
//
// src/orders-repo.ts:9-13 states the project's own rule for choosing column types:
//   "BIGINT, not INTEGER: calculateRefund admits totals up to
//    Number.MAX_SAFE_INTEGER, and INT4 tops out at 2147483647. A domain that
//    accepts a value the schema cannot store fails at insert with a raw
//    driver error instead of a domain one."
//
// That reasoning was applied to `total_cents` and to nothing else. `bookTickets`
// admits any finite `discountPercent` in 0..100 (src/booking.ts:21) and hands
// back an order carrying it — the fast suite books at 33.33 and at arbitrary
// doubles (tests/refund.property.test.ts:86, tests/refund.contract.property.test.ts:88)
// — but the column is INTEGER (src/orders-repo.ts:15), and `event_start_ms` is
// BIGINT while `calculateRefund` admits fractional instants. Saving such an
// order dies with exactly the error the comment above says it exists to prevent:
//   error: invalid input syntax for type integer: "33.33"
//     at Module.saveOrder src/orders-repo.ts:28
//
// Every existing persistence test saves whole-number discounts only
// (tests/integration/orders-repo.test.ts:25 uses 10, orders-storage.test.ts and
// refund-persistence.test.ts use 0), so the mismatch is never touched.
//
// Two fixes satisfy these tests, and both are fine: widen the columns to hold
// what the domain admits, or narrow the domain so `bookTickets` refuses a
// fractional discount with a RangeError. What is not fine is the third option
// currently shipping — accept it at the front door, then fail in the driver.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { initSchema, saveOrder, getOrder } from "../../src/orders-repo";
import { bookTickets, Event } from "../../src/booking";
import { Order } from "../../src/refund";

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

const EVENT_START = 1_800_000_000_000;

async function roundTrip(o: Order): Promise<Order> {
  const id = await saveOrder(db, o);
  const loaded = await getOrder(db, id);
  expect(loaded).not.toBeNull();
  return loaded!;
}

const venue: Event = {
  id: "rockfest",
  name: "RockFest 2026",
  totalSeats: 100,
  seatsSold: 0,
  priceCents: 5_000,
  startMs: EVENT_START,
};

describe("an order comes back from the database as the order that went in", () => {
  // INVARIANT: saving and loading is the identity. A persistence layer that
  // quietly edits a field is worse than one that refuses it — the refusal is
  // visible, the edit is not.
  it("round-trips a fractional discount without editing it", async () => {
    const order = bookTickets(venue, 3, 33.33);
    expect(order.discountPercent).toBe(33.33);

    const loaded = await roundTrip(order);

    expect(loaded.discountPercent).toBe(33.33);
  });

  it.each([
    ["a third off", 33.33],
    ["a hair under a half", 49.5],
    ["a fraction of a percent", 0.5],
    ["almost everything", 99.99],
  ])("round-trips %s", async (_label, discountPercent) => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent,
      eventStartMs: EVENT_START,
    });

    expect(loaded.discountPercent).toBe(discountPercent);
  });

  // Same mismatch, one column over: `calculateRefund` admits a fractional
  // `eventStartMs` (src/refund.ts:42 checks only that it is finite) and
  // `bookTickets` stamps whatever the event carries onto the order, but
  // `event_start_ms` is BIGINT.
  it("round-trips a fractional event start", async () => {
    const loaded = await roundTrip({
      totalCents: 10_000,
      tickets: 4,
      discountPercent: 0,
      eventStartMs: EVENT_START + 0.5,
    });

    expect(loaded.eventStartMs).toBe(EVENT_START + 0.5);
  });

  // The whole order, field by field, for the values the domain actually admits.
  it("round-trips every field of a domain-legal order", async () => {
    const order: Order = {
      totalCents: 10_001,
      tickets: 3,
      discountPercent: 12.5,
      eventStartMs: EVENT_START,
    };

    const loaded = await roundTrip(order);

    expect(loaded).toEqual(order);
  });
});
