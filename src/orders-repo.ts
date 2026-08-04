import { Client } from "pg";
import { Order } from "./refund";

/** Persistence for orders — real Postgres, no mocks in tests (Testcontainers). */
export async function initSchema(db: Client): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      -- BIGINT: the domain admits totals up to Number.MAX_SAFE_INTEGER; INT4 is narrower
      total_cents BIGINT NOT NULL,
      tickets BIGINT NOT NULL,
      -- float8: fractional discounts and sub-millisecond starts are legal orders
      discount_percent DOUBLE PRECISION NOT NULL,
      event_start_ms DOUBLE PRECISION NOT NULL,
      refunded_at TIMESTAMPTZ
    )
  `);
  // Widen columns from earlier schema versions — every one is a no-op when current.
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`);
  await db.query(`ALTER TABLE orders ALTER COLUMN total_cents TYPE BIGINT`);
  await db.query(`ALTER TABLE orders ALTER COLUMN discount_percent TYPE DOUBLE PRECISION`);
  await db.query(`ALTER TABLE orders ALTER COLUMN event_start_ms TYPE DOUBLE PRECISION`);
  await db.query(`ALTER TABLE orders ALTER COLUMN tickets TYPE BIGINT`);
}

export async function saveOrder(db: Client, o: Order): Promise<number> {
  // float8 stores NaN/±Infinity without complaint — refuse non-finite fields here
  // rather than persist an order calculateRefund will refuse forever.
  for (const [field, value] of [
    ["totalCents", o.totalCents],
    ["tickets", o.tickets],
    ["discountPercent", o.discountPercent],
    ["eventStartMs", o.eventStartMs],
  ] as const) {
    if (!Number.isFinite(value)) throw new RangeError(`${field} must be finite`);
  }
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
    // BIGINT comes back from the pg driver as a string — coerce every column.
    totalCents: Number(row.total_cents),
    tickets: Number(row.tickets),
    discountPercent: Number(row.discount_percent),
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
