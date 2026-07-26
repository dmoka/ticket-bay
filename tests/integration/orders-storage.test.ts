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
