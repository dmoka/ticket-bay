import { Client } from "pg";
import { Order } from "./refund";

/** Persistence for orders — real Postgres, no mocks in tests (Testcontainers). */
export async function initSchema(db: Client): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      -- BIGINT, not INTEGER: calculateRefund admits totals up to
      -- Number.MAX_SAFE_INTEGER, and INT4 tops out at 2147483647. A domain that
      -- accepts a value the schema cannot store fails at insert with a raw
      -- driver error instead of a domain one.
      total_cents BIGINT NOT NULL,
      tickets INTEGER NOT NULL,
      discount_percent INTEGER NOT NULL,
      event_start_ms BIGINT NOT NULL,
      refunded_at TIMESTAMPTZ
    )
  `);
  // Older databases created before refunds were tracked.
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`);
  // Older databases created while total_cents was still INT4. Widening is a
  // no-op once it is already BIGINT, so this is safe to run every time.
  await db.query(`ALTER TABLE orders ALTER COLUMN total_cents TYPE BIGINT`);
}

export async function saveOrder(db: Client, o: Order): Promise<number> {
  const r = await db.query(
    `INSERT INTO orders (total_cents, tickets, discount_percent, event_start_ms)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [o.totalCents, o.tickets, o.discountPercent, o.eventStartMs],
  );
  return r.rows[0].id as number;
}

export async function getOrder(db: Client, id: number): Promise<Order | null> {
  const r = await db.query(`SELECT * FROM orders WHERE id = $1`, [id]);
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    // BIGINT comes back from Postgres as a string — a real-driver truth no mock
    // would tell you. Both of these columns are BIGINT, so both need coercing.
    totalCents: Number(row.total_cents),
    tickets: row.tickets,
    discountPercent: row.discount_percent,
    eventStartMs: Number(row.event_start_ms),
  };
}

/**
 * Mark an order refunded, exactly once. Returns true if this call performed the
 * refund, false if it had already been refunded (or the order does not exist).
 * The guard lives in the WHERE clause so concurrent callers cannot both win.
 */
export async function markRefunded(db: Client, id: number): Promise<boolean> {
  const r = await db.query(
    `UPDATE orders SET refunded_at = now() WHERE id = $1 AND refunded_at IS NULL`,
    [id],
  );
  return r.rowCount === 1;
}

/** Whether an order has already been refunded. */
export async function isRefunded(db: Client, id: number): Promise<boolean> {
  const r = await db.query(`SELECT refunded_at FROM orders WHERE id = $1`, [id]);
  return r.rows.length > 0 && r.rows[0].refunded_at !== null;
}
