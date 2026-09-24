import { and, desc, eq } from "drizzle-orm";
import type { Order } from "../domain/refund";
import type { DbLike } from "./client";
import { events, orders, type EventRow, type OrderRow } from "./schema";

export type NewOrder = typeof orders.$inferInsert;

export async function insertOrder(db: DbLike, row: NewOrder): Promise<OrderRow> {
  // Postgres refuses 1.5 in a BIGINT column, but only with a driver error that
  // names no field, and a value past 2^53 would already have lost precision in
  // JS. This catches fractions, NaN and unsafe integers with an error that
  // names the field.
  for (const field of ["quantity", "subtotalCents", "discountCents", "ticketsCents", "feeCents", "totalCents", "vatCents"] as const) {
    if (!Number.isSafeInteger(row[field])) throw new RangeError(`${field} must be a safe integer`);
  }
  const [created] = await db.insert(orders).values(row).returning();
  return created;
}

export async function getOrder(db: DbLike, id: number): Promise<OrderRow | undefined> {
  const [row] = await db.select().from(orders).where(eq(orders.id, id));
  return row;
}

export async function getOrderWithEvent(db: DbLike, id: number): Promise<{ order: OrderRow; event: EventRow } | undefined> {
  const [r] = await db.select().from(orders).innerJoin(events, eq(orders.eventId, events.id)).where(eq(orders.id, id));
  return r ? { order: r.orders, event: r.events } : undefined;
}

export async function getOrderByIdempotencyKey(db: DbLike, key: string): Promise<OrderRow | undefined> {
  const [row] = await db.select().from(orders).where(eq(orders.idempotencyKey, key));
  return row;
}

export async function listOrdersByEmail(db: DbLike, email: string): Promise<{ order: OrderRow; event: EventRow }[]> {
  const rows = await db
    .select()
    .from(orders)
    .innerJoin(events, eq(orders.eventId, events.id))
    .where(eq(orders.customerEmail, email.trim().toLowerCase()))
    .orderBy(desc(orders.createdAtMs));
  return rows.map((r) => ({ order: r.orders, event: r.events }));
}

/**
 * The refund module's view of a stored order: what was paid for the tickets
 * (the service fee is not refundable) and when the event starts.
 */
export function toDomainOrder(order: OrderRow, event: Pick<EventRow, "startsAtMs">): Order {
  return {
    totalCents: order.ticketsCents,
    tickets: order.quantity,
    discountPercent: order.discountPercent,
    eventStartMs: event.startsAtMs,
  };
}

export interface RefundRecord {
  atMs: number;
  refundCents: number;
  refundFeeCents: number;
  seatsReleased: boolean;
}

/**
 * Mark an order refunded, exactly once. Returns true if this call performed the
 * refund, false if it had already been refunded (or does not exist). The guard
 * lives in the WHERE clause, so two callers cannot both win: in Postgres the
 * second UPDATE waits on the first one's row lock, then re-checks
 * `status = 'paid'` against the committed row and matches nothing.
 */
export async function markRefunded(db: DbLike, id: number, r: RefundRecord): Promise<boolean> {
  const res = await db
    .update(orders)
    .set({
      status: "refunded",
      refundedAtMs: r.atMs,
      refundCents: r.refundCents,
      refundFeeCents: r.refundFeeCents,
      seatsReleased: r.seatsReleased,
    })
    .where(and(eq(orders.id, id), eq(orders.status, "paid")));
  return res.rowCount === 1;
}

export async function setRefundId(db: DbLike, id: number, refundId: string): Promise<void> {
  await db.update(orders).set({ refundId }).where(eq(orders.id, id));
}

export async function isRefunded(db: DbLike, id: number): Promise<boolean> {
  return (await getOrder(db, id))?.status === "refunded";
}
