// Migration 0003 against a database that already holds refunds the old way
// (on the orders row): it is migrated up to 0002, given legacy rows, then
// migrated to the end. Every refunded order must come out as exactly one
// refund row carrying the same money, and the payout keys the old code used.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, openDb, type Db } from "../../src/db/client";
import { listRefundsForOrder } from "../../src/db/refunds-repo";
import { refundsSoFar } from "../../src/domain/cancellation";
import { NOW } from "./fixtures";

const name = `ticketbay_mig_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const url = new URL(inject("adminDatabaseUrl"));
url.pathname = `/${name}`;
let db: Db;
let upTo0002: string;

async function admin(statement: string) {
  const c = new Client({ connectionString: inject("adminDatabaseUrl") });
  await c.connect();
  try {
    await c.query(statement);
  } finally {
    await c.end();
  }
}

/** A copy of drizzle/ that stops after migration 0002. */
function migrationsUpTo0002(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ticketbay-mig-"));
  fs.mkdirSync(path.join(dir, "meta"));
  const journal = JSON.parse(fs.readFileSync("drizzle/meta/_journal.json", "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 2);
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) fs.copyFileSync(path.join("drizzle", `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

beforeAll(async () => {
  await admin(`CREATE DATABASE ${name}`);
  db = openDb(url.toString());
  upTo0002 = migrationsUpTo0002();
  await migrate(db, { migrationsFolder: upTo0002 });

  await db.execute(sql`INSERT INTO events (id, name, category, venue, city, starts_at_ms, total_seats, seats_sold, price_cents, created_at_ms, cancelled_at_ms)
    VALUES ('legacy', 'Legacy Fest', 'concert', 'Arena', 'Budapest', ${NOW + 86_400_000}, 100, 3, 5000, ${NOW - 86_400_000}, NULL)`);
  const order = (id: number, status: string, extra: string) =>
    sql.raw(`INSERT INTO orders (event_id, customer_email, customer_name, quantity, subtotal_cents, discount_percent, discount_cents,
      tickets_cents, fee_cents, total_cents, vat_cents, status, payment_id, idempotency_key, created_at_ms,
      refunded_at_ms, refund_cents, refund_fee_cents, seats_released, refund_id, refund_reason)
      VALUES ('legacy', 'fan${id}@example.com', 'Fan', 2, 10000, 0, 0, 10000, 300, 10300, 2190, '${status}', 'ch_${id}', 'key-${id}', ${NOW}, ${extra})`);
  // 1: customer cancel, paid out. 2: customer cancel, payout still owed. 3: after the start, nothing back.
  // 4: the event was cancelled. 5: never refunded.
  await db.execute(order(1, "refunded", `${NOW + 1}, 9800, 200, true, 're_one', 'customer'`));
  await db.execute(order(2, "refunded", `${NOW + 2}, 9800, 200, true, NULL, 'customer'`));
  await db.execute(order(3, "refunded", `${NOW + 3}, 0, 0, false, NULL, 'customer'`));
  await db.execute(order(4, "refunded", `${NOW + 4}, 10000, 0, true, 're_four', 'event_cancelled'`));
  await db.execute(order(5, "paid", `NULL, NULL, NULL, NULL, NULL, NULL`));

  await migrate(db, { migrationsFolder: "drizzle" });
}, 60_000);

afterAll(async () => {
  if (db) await closeDb(db);
  await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  if (upTo0002) fs.rmSync(upTo0002, { recursive: true, force: true });
});

describe("migration 0003: refunds move to their own table", () => {
  it("copies every refunded order into exactly one refund row with the same money", async () => {
    const shape = async (id: number) =>
      (await listRefundsForOrder(db, id)).map((r) => ({
        tickets: r.tickets,
        grossCents: r.grossCents,
        feeCents: r.feeCents,
        netCents: r.netCents,
        reason: r.reason,
        createdAtMs: r.createdAtMs,
        seatsReleased: r.seatsReleased,
        idempotencyKey: r.idempotencyKey,
        providerRefundId: r.providerRefundId,
      }));
    expect(await shape(1)).toEqual([
      { tickets: 2, grossCents: 10_000, feeCents: 200, netCents: 9_800, reason: "customer", createdAtMs: NOW + 1, seatsReleased: true, idempotencyKey: "refund-1", providerRefundId: "re_one" },
    ]);
    // The owed payout keeps the key the old code sent, so finishing it cannot pay twice.
    expect(await shape(2)).toEqual([
      { tickets: 2, grossCents: 10_000, feeCents: 200, netCents: 9_800, reason: "customer", createdAtMs: NOW + 2, seatsReleased: true, idempotencyKey: "refund-2", providerRefundId: null },
    ]);
    expect(await shape(3)).toEqual([
      { tickets: 2, grossCents: 0, feeCents: 0, netCents: 0, reason: "customer", createdAtMs: NOW + 3, seatsReleased: false, idempotencyKey: "refund-3", providerRefundId: null },
    ]);
    expect(await shape(4)).toEqual([
      { tickets: 2, grossCents: 10_000, feeCents: 0, netCents: 10_000, reason: "event_cancelled", createdAtMs: NOW + 4, seatsReleased: true, idempotencyKey: "event-cancel-4", providerRefundId: "re_four" },
    ]);
    expect(await shape(5)).toEqual([]);
  });

  it("the copied rows count every ticket as cancelled, so nothing more can be refunded on them", async () => {
    for (const id of [1, 2, 3, 4]) expect(refundsSoFar(await listRefundsForOrder(db, id)).ticketsCancelled).toBe(2);
    const err = await db
      .execute(sql`INSERT INTO refunds (order_id, tickets, gross_cents, fee_cents, net_cents, reason, created_at_ms, seats_released, idempotency_key)
        VALUES (1, 1, 0, 0, 0, 'customer', ${NOW}, true, 'one-more')`)
      .then(
        () => null,
        (e: { cause?: { constraint?: string } }) => e.cause?.constraint,
      );
    expect(err).toBe("refunds_tickets_within_order");
  });

  it("leaves the old columns in place for the later migration that drops them", async () => {
    const r = await db.execute(sql`SELECT refund_cents FROM orders WHERE id = 1`);
    // A raw query gets BIGINT back as a string.
    expect(r.rows[0]).toEqual({ refund_cents: "9800" });
  });
});
