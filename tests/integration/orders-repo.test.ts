// Integration tests against REAL Postgres via Testcontainers. No mocks.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { initSchema, saveOrder, getOrder } from "../../src/orders-repo";
import { calculateRefund } from "../../src/refund";

let container: StartedPostgreSqlContainer;
let db: Client;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  db = new Client({ connectionString: container.getConnectionUri() });
  await db.connect();
  await initSchema(db);
}, 120000);

afterAll(async () => {
  await db?.end();
  await container?.stop();
});

describe("orders repository (real Postgres)", () => {
  it("round-trips an order through the real database", async () => {
    const order = { totalCents: 10000, tickets: 4, discountPercent: 10, eventStartMs: 2000000000000 };
    const id = await saveOrder(db, order);
    const loaded = await getOrder(db, id);
    expect(loaded).toEqual(order);
  });

  it("keeps event timestamps usable as numbers after storage (BIGINT comes back as string)", async () => {
    const order = { totalCents: 5000, tickets: 2, discountPercent: 0, eventStartMs: 2000000000001 };
    const id = await saveOrder(db, order);
    const loaded = await getOrder(db, id);
    expect(typeof loaded!.eventStartMs).toBe("number");
    // and the loaded order still computes a refund correctly
    expect(calculateRefund(loaded!, 2, loaded!.eventStartMs - 1000)).toBe(5000);
  });

  it("returns null for a missing order", async () => {
    expect(await getOrder(db, 999999)).toBeNull();
  });
});
