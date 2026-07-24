import { Client } from "pg";
import { Order } from "./refund";

/** Persistence for orders — real Postgres, no mocks in tests (Testcontainers). */
export async function initSchema(db: Client): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      total_cents INTEGER NOT NULL,
      tickets INTEGER NOT NULL,
      discount_percent INTEGER NOT NULL,
      event_start_ms BIGINT NOT NULL
    )
  `);
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
    totalCents: row.total_cents,
    tickets: row.tickets,
    discountPercent: row.discount_percent,
    // BIGINT comes back from Postgres as a string — a real-driver truth no mock would tell you
    eventStartMs: Number(row.event_start_ms),
  };
}
