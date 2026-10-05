import { and, asc, eq, inArray, isNull, gt } from "drizzle-orm";
import type { DbLike } from "./client";
import { orders, refunds, type RefundRow } from "./schema";

export type NewRefund = typeof refunds.$inferInsert;

/**
 * Record one cancellation. The database refuses a row that would cancel more
 * tickets than the order has or refund more than its tickets cost (the
 * `refunds_within_order` trigger), so a bug upstream fails loudly instead of
 * paying out.
 */
export async function insertRefund(db: DbLike, row: NewRefund): Promise<RefundRow> {
  // Same reason as insertOrder: a fraction or an unsafe integer gets an error that names the field.
  for (const field of ["tickets", "grossCents", "feeCents", "netCents", "createdAtMs"] as const) {
    if (!Number.isSafeInteger(row[field])) throw new RangeError(`${field} must be a safe integer`);
  }
  const [created] = await db.insert(refunds).values(row).returning();
  return created;
}

export async function getRefundByIdempotencyKey(db: DbLike, key: string): Promise<RefundRow | undefined> {
  const [row] = await db.select().from(refunds).where(eq(refunds.idempotencyKey, key));
  return row;
}

/** One order's refunds, oldest first. */
export async function listRefundsForOrder(db: DbLike, orderId: number): Promise<RefundRow[]> {
  return db.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(asc(refunds.id));
}

/** Refunds of many orders at once, oldest first per order. Orders without one map to []. */
export async function listRefundsForOrders(db: DbLike, orderIds: readonly number[]): Promise<Map<number, RefundRow[]>> {
  const byOrder = new Map<number, RefundRow[]>(orderIds.map((id) => [id, []]));
  if (orderIds.length === 0) return byOrder;
  const rows = await db.select().from(refunds).where(inArray(refunds.orderId, [...orderIds])).orderBy(asc(refunds.id));
  for (const r of rows) byOrder.get(r.orderId)!.push(r);
  return byOrder;
}

/** The refunds an event cancellation made, oldest first, each with the charge it pays back. */
export async function listEventCancelRefunds(db: DbLike, eventId: string): Promise<{ refund: RefundRow; paymentId: string }[]> {
  return db
    .select({ refund: refunds, paymentId: orders.paymentId })
    .from(refunds)
    .innerJoin(orders, eq(refunds.orderId, orders.id))
    .where(and(eq(orders.eventId, eventId), eq(refunds.reason, "event_cancelled")))
    .orderBy(asc(refunds.id));
}

/** …of those, the ones whose money has not reached the provider yet. */
export async function listUnpaidEventCancelRefunds(db: DbLike, eventId: string): Promise<{ refund: RefundRow; paymentId: string }[]> {
  return (await listEventCancelRefunds(db, eventId)).filter((r) => owed(r.refund));
}

/** A customer's refunds on one order whose money has not reached the provider yet. */
export async function listUnpaidCustomerRefunds(db: DbLike, orderId: number): Promise<RefundRow[]> {
  return db
    .select()
    .from(refunds)
    .where(and(eq(refunds.orderId, orderId), eq(refunds.reason, "customer"), isNull(refunds.providerRefundId), gt(refunds.netCents, 0)))
    .orderBy(asc(refunds.id));
}

/** Money is owed on a refund until the provider has confirmed it. */
export const owed = (r: RefundRow) => r.providerRefundId === null && r.netCents > 0;

export async function setProviderRefundId(db: DbLike, refundId: number, providerRefundId: string): Promise<void> {
  await db.update(refunds).set({ providerRefundId }).where(eq(refunds.id, refundId));
}
