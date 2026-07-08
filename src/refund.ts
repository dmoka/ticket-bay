export interface Order {
  /** total paid, in cents */
  totalCents: number;
  /** number of tickets in the order */
  tickets: number;
  /** percentage discount applied at purchase, 0-100 */
  discountPercent: number;
}

/**
 * Refund for cancelling `cancelled` tickets from an order.
 * Refund is proportional to the tickets cancelled, minus the discount
 * that was applied at purchase. Result is rounded to whole cents.
 */
export function calculateRefund(order: Order, cancelled: number): number {
  if (cancelled < 0 || cancelled > order.tickets) {
    throw new RangeError("cancelled tickets out of range");
  }
  const perTicket = order.totalCents / order.tickets;
  const gross = perTicket * cancelled;
  const discounted = gross * (1 - order.discountPercent / 100);
  return Math.round(discounted);
}

/** Fee kept by the platform on every refund, in cents. Min 50, 2% of refund. */
export function refundFee(refundCents: number): number {
  const fee = Math.round(refundCents * 0.02);
  return fee >= 50 ? fee : 50;
}

/** Net amount returned to the customer. Never negative. */
export function netRefund(order: Order, cancelled: number): number {
  const refund = calculateRefund(order, cancelled);
  if (refund === 0) return 0;
  const net = refund - refundFee(refund);
  return net > 0 ? net : 0;
}
