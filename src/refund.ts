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
 *
 * Stateless by contract: this is handed the ORIGINAL order on every call and
 * cannot see cancellations that came before it. Refunding a whole order in one
 * call is exact. A caller that cancels piecemeal must track the cents already
 * refunded and cap the running total at `totalCents`, because each call rounds
 * to the nearest cent independently and the rounding is up whenever
 * `2 * (totalCents mod tickets) >= tickets`. The overshoot reaches half a cent
 * per ticket — `{totalCents: 150, tickets: 300}` pays out 150 cents too much
 * one ticket at a time. Note this is NOT limited to orders that cost less than
 * they have tickets: `{totalCents: 10001, tickets: 3}` overshoots too.
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
  if (!Number.isInteger(order.totalCents) || order.totalCents < 0 || order.totalCents > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("order total out of range");
  }
  if (!Number.isFinite(order.eventStartMs)) {
    throw new RangeError("event start out of range");
  }
  // The clock decides whether money moves, so it is validated like any other
  // input: an absent or broken clock must never fall through to a payout.
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("current time out of range");
  }
  return exactShare(order.totalCents, cancelled, order.tickets);
}

/**
 * `total * part / whole`, rounded half up, computed exactly.
 *
 * Done in floating point, the multiply overflows 2^53 on totals this function
 * explicitly admits, and the result can come back a cent above what was paid.
 * BigInt keeps the product exact; the quotient always fits back in a number
 * because `part <= whole` means it never exceeds `total`.
 */
function exactShare(total: number, part: number, whole: number): number {
  const numerator = BigInt(total) * BigInt(part);
  const denominator = BigInt(whole);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return Number(remainder * 2n >= denominator ? quotient + 1n : quotient);
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
