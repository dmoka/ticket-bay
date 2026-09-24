import { and, desc, eq } from "drizzle-orm";
import type { Order } from "../domain/refund";
import type { DbLike } from "./client";
import { events, orders, type EventRow, type OrderRow } from "./schema";

export type NewOrder = typeof orders.$inferInsert;

export function insertOrder(db: DbLike, row: NewOrder): OrderRow {
  // SQLite would store NaN as NULL and 1.5 as a REAL; the CHECK constraints
  // catch the second, this catches both with an error that names the field.
  for (const field of ["quantity", "subtotalCents", "discountCents", "ticketsCents", "feeCents", "totalCents", "vatCents"] as const) {
    if (!Number.isSafeInteger(row[field])) throw new RangeError(`${field} must be a safe integer`);
  }
  return db.insert(orders).values(row).returning().get();
}

export function getOrder(db: DbLike, id: number): OrderRow | undefined {
  return db.select().from(orders).where(eq(orders.id, id)).get();
}

export function getOrderWithEvent(db: DbLike, id: number): { order: OrderRow; event: EventRow } | undefined {
  const r = db.select().from(orders).innerJoin(events, eq(orders.eventId, events.id)).where(eq(orders.id, id)).get();
  return r ? { order: r.orders, event: r.events } : undefined;
}

export function getOrderByIdempotencyKey(db: DbLike, key: string): OrderRow | undefined {
  return db.select().from(orders).where(eq(orders.idempotencyKey, key)).get();
}

export function listOrdersByEmail(db: DbLike, email: string): { order: OrderRow; event: EventRow }[] {
  return db
    .select()
    .from(orders)
    .innerJoin(events, eq(orders.eventId, events.id))
    .where(eq(orders.customerEmail, email.trim().toLowerCase()))
    .orderBy(desc(orders.createdAtMs))
    .all()
    .map((r) => ({ order: r.orders, event: r.events }));
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
 * lives in the WHERE clause, so two callers cannot both win.
 */
export function markRefunded(db: DbLike, id: number, r: RefundRecord): boolean {
  const res = db
    .update(orders)
    .set({
      status: "refunded",
      refundedAtMs: r.atMs,
      refundCents: r.refundCents,
      refundFeeCents: r.refundFeeCents,
      seatsReleased: r.seatsReleased,
    })
    .where(and(eq(orders.id, id), eq(orders.status, "paid")))
    .run();
  return res.changes === 1;
}

export function setRefundId(db: DbLike, id: number, refundId: string): void {
  db.update(orders).set({ refundId }).where(eq(orders.id, id)).run();
}

export function isRefunded(db: DbLike, id: number): boolean {
  return getOrder(db, id)?.status === "refunded";
}
