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
      -- BIGINT: calculateRefund admits any integer ticket count above zero and
      -- bookTickets will sell whatever a venue has seats for, so INT4's
      -- 2,147,483,647 ceiling was narrower than the domain.
      tickets BIGINT NOT NULL,
      -- DOUBLE PRECISION, not INTEGER/BIGINT. The domain admits any finite
      -- discount in 0..100 (src/booking.ts) and any finite event start
      -- (src/refund.ts), so 33.33% and a sub-millisecond start are both legal
      -- orders. Integer columns rejected them at insert with a raw driver
      -- error — the exact failure the total_cents comment above describes,
      -- fixed on one column and left on its neighbours. float8 is the same
      -- IEEE-754 double the domain already uses, so nothing is rounded on the
      -- way in or out.
      discount_percent DOUBLE PRECISION NOT NULL,
      event_start_ms DOUBLE PRECISION NOT NULL,
      refunded_at TIMESTAMPTZ
    )
  `);
  // Older databases created before refunds were tracked.
  await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`);
  // Older databases created while total_cents was still INT4. Widening is a
  // no-op once it is already BIGINT, so this is safe to run every time.
  await db.query(`ALTER TABLE orders ALTER COLUMN total_cents TYPE BIGINT`);
  // Older databases that stored the discount and the event start as integers,
  // and so could not hold a fractional discount or a sub-millisecond start.
  await db.query(`ALTER TABLE orders ALTER COLUMN discount_percent TYPE DOUBLE PRECISION`);
  await db.query(`ALTER TABLE orders ALTER COLUMN event_start_ms TYPE DOUBLE PRECISION`);
  // Older databases that capped the ticket count at INT4.
  await db.query(`ALTER TABLE orders ALTER COLUMN tickets TYPE BIGINT`);
}

export async function saveOrder(db: Client, o: Order): Promise<number> {
  // The domain is defined in FINITE numbers — every field is validated with
  // Number.isFinite or tighter in src/refund.ts. DOUBLE PRECISION is not: float8
  // has encodings for NaN and ±Infinity and Postgres stores them without
  // complaint, so widening those columns quietly removed a rejection the integer
  // types used to perform. Refuse here with a domain error rather than persist an
  // order calculateRefund will refuse forever — paid for, never refundable, which
  // is the same hazard src/booking.ts guards against on the way in.
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
    // BIGINT comes back from Postgres as a STRING — a real-driver truth no mock
    // would tell you — so total_cents needs coercing. DOUBLE PRECISION comes
    // back as a number already; Number() on the other two is belt and braces
    // and costs nothing, and keeps this honest if a column type ever changes.
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
