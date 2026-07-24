export interface Order {
  /** total actually paid, in cents */
  totalCents: number;
  /** number of tickets in the order */
  tickets: number;
  /** percentage discount applied at purchase, 0-100 (informational) */
  discountPercent: number;
  /** when the event starts, ms since epoch — refunds close at this moment */
  eventStartMs: number;
}

/**
 * Refund for cancelling `cancelled` tickets, proportional to the amount
 * actually paid, rounded to the nearest cent.
 *
 * Business rule: cancellations are only allowed BEFORE the event starts.
 * From `eventStartMs` on, the refund is zero.
 */
export function calculateRefund(order: Order, cancelled: number, nowMs: number): number {
  if (!Number.isInteger(cancelled) || cancelled < 0 || cancelled > order.tickets) {
    throw new RangeError("cancelled tickets out of range");
  }
  if (!Number.isInteger(order.tickets) || order.tickets <= 0) {
    throw new RangeError("order must have at least one ticket");
  }
  if (!(order.discountPercent >= 0 && order.discountPercent <= 100)) {
    throw new RangeError("discount out of range");
  }
  if (!Number.isInteger(order.totalCents) || order.totalCents < 0) {
    throw new RangeError("order total out of range");
  }
  return Math.round((order.totalCents * cancelled) / order.tickets);
}

/** Fee kept by the platform on every refund, in cents. Min 50, 2% of refund. */
export function refundFee(refundCents: number): number {
  if (refundCents <= 0) return 0;
  const fee = Math.round(refundCents * 0.02);
  const floored = fee >= 50 ? fee : 50;
  return floored > refundCents ? refundCents : floored;
}

/** Net amount returned to the customer. Never negative. */
export function netRefund(order: Order, cancelled: number, nowMs: number): number {
  const refund = calculateRefund(order, cancelled, nowMs);
  if (refund === 0) return 0;
  const net = refund - refundFee(refund);
  return net > 0 ? net : 0;
}
