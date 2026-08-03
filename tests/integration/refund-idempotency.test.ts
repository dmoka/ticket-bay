// Integration tests for refund idempotency against REAL Postgres (Testcontainers).
// The exactly-once guard in markRefunded lives in a WHERE clause, so it can only be
// verified against a real database with real row locks and real concurrent transactions.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { initSchema, saveOrder, getOrder, markRefunded, isRefunded } from "../../src/orders-repo";
import { netRefund, Order } from "../../src/refund";

let container: StartedPostgreSqlContainer;
let db: Client;
let other: Client; // a second real connection, for contention tests

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const uri = container.getConnectionUri();
  db = new Client({ connectionString: uri });
  other = new Client({ connectionString: uri });
  await db.connect();
  await other.connect();
}, 120000);

afterAll(async () => {
  await db?.end();
  await other?.end();
  await container?.stop();
});

// Fresh schema for every test — no refunded rows survive from one test to the next.
beforeEach(async () => {
  await db.query(`DROP TABLE IF EXISTS orders`);
  await initSchema(db);
});

const EVENT_START = 1_800_000_000_000;
const HOUR = 3_600_000;

const anOrder = (over: Partial<Order> = {}): Order => ({
  totalCents: 10_000,
  tickets: 4,
  discountPercent: 0,
  eventStartMs: EVENT_START,
  ...over,
});

describe("marking an order refunded (real Postgres)", () => {
  it("reports an unrefunded order as not refunded", async () => {
    const id = await saveOrder(db, anOrder());
    expect(await isRefunded(db, id)).toBe(false);
  });

  it("succeeds the first time and refuses the second", async () => {
    const id = await saveOrder(db, anOrder());

    expect(await markRefunded(db, id)).toBe(true);
    expect(await markRefunded(db, id)).toBe(false);
    expect(await isRefunded(db, id)).toBe(true);
  });

  it("stays refused on every later attempt", async () => {
    const id = await saveOrder(db, anOrder());
    await markRefunded(db, id);

    for (let i = 0; i < 5; i++) {
      expect(await markRefunded(db, id)).toBe(false);
    }
    expect(await isRefunded(db, id)).toBe(true);
  });

  it("stamps a refund time that the database can read back", async () => {
    const id = await saveOrder(db, anOrder());
    await markRefunded(db, id);

    const r = await db.query(`SELECT refunded_at FROM orders WHERE id = $1`, [id]);
    expect(r.rows[0].refunded_at).toBeInstanceOf(Date);
  });

  it("does not disturb the stored order fields", async () => {
    const order = anOrder({ totalCents: 7_777, tickets: 3, discountPercent: 15 });
    const id = await saveOrder(db, order);
    await markRefunded(db, id);

    expect(await getOrder(db, id)).toEqual(order);
  });

  it("refuses to refund an order that does not exist", async () => {
    expect(await markRefunded(db, 999_999)).toBe(false);
    expect(await isRefunded(db, 999_999)).toBe(false);
  });

  it("refunds only the order asked for", async () => {
    const first = await saveOrder(db, anOrder());
    const second = await saveOrder(db, anOrder());

    expect(await markRefunded(db, first)).toBe(true);

    expect(await isRefunded(db, first)).toBe(true);
    expect(await isRefunded(db, second)).toBe(false);
    expect(await markRefunded(db, second)).toBe(true);
  });
});

describe("concurrent refunds of the same order (real transactions)", () => {
  it("lets exactly one of two overlapping transactions win", async () => {
    const id = await saveOrder(db, anOrder());

    await db.query("BEGIN");
    await other.query("BEGIN");

    // First transaction takes the row and holds the lock without committing.
    const firstWon = await markRefunded(db, id);

    // Second transaction now blocks on that row until the first commits.
    const secondPending = markRefunded(other, id);
    await new Promise((r) => setTimeout(r, 250));

    await db.query("COMMIT");
    const secondWon = await secondPending;
    await other.query("COMMIT");

    expect(firstWon).toBe(true);
    expect(secondWon).toBe(false);
    expect([firstWon, secondWon].filter(Boolean)).toHaveLength(1);
    expect(await isRefunded(db, id)).toBe(true);
  });

  it("pays a customer out only once even when the refund is requested twice at once", async () => {
    const order = anOrder();
    const id = await saveOrder(db, order);
    const loaded = (await getOrder(db, id))!;
    const beforeStart = loaded.eventStartMs - HOUR;

    // Two racing refund requests; each pays out only if it wins the guard.
    const payouts = await Promise.all(
      [db, other].map(async (conn) =>
        (await markRefunded(conn, id)) ? netRefund(loaded, loaded.tickets, beforeStart) : 0,
      ),
    );

    const total = payouts.reduce((a, b) => a + b, 0);
    expect(total).toBe(9_800);
    expect(total).toBeLessThanOrEqual(order.totalCents);
  });

  it("keeps the guard intact when many callers pile on at once", async () => {
    const id = await saveOrder(db, anOrder());

    const results = await Promise.all(Array.from({ length: 8 }, () => markRefunded(db, id)));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await isRefunded(db, id)).toBe(true);
  });

  it("does not lose the refund when its transaction rolls back", async () => {
    const id = await saveOrder(db, anOrder());

    await db.query("BEGIN");
    expect(await markRefunded(db, id)).toBe(true);
    await db.query("ROLLBACK");

    // The refund never committed, so the money was never sent — the order must
    // still be refundable rather than stuck as spent.
    expect(await isRefunded(db, id)).toBe(false);
    expect(await markRefunded(db, id)).toBe(true);
  });
});

describe("schema setup (real Postgres)", () => {
  it("can be initialised twice without error", async () => {
    await initSchema(db);
    await initSchema(db);

    const id = await saveOrder(db, anOrder());
    expect(await markRefunded(db, id)).toBe(true);
  });

  it("migrates an older orders table that predates refund tracking", async () => {
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
    const legacy = await db.query(
      `INSERT INTO orders (total_cents, tickets, discount_percent, event_start_ms)
       VALUES (10000, 4, 0, $1) RETURNING id`,
      [EVENT_START],
    );
    const id = legacy.rows[0].id as number;

    await initSchema(db);

    // The pre-existing row must be treated as not yet refunded, and refundable once.
    expect(await isRefunded(db, id)).toBe(false);
    expect(await markRefunded(db, id)).toBe(true);
    expect(await markRefunded(db, id)).toBe(false);
    expect(await getOrder(db, id)).toEqual(anOrder());
  });
});
