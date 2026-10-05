import { calculateRefund, paidShare, refundFee, type Order } from "./refund";

export interface CancellationPreview {
  /** false once the event has started — refunds close at `eventStartMs` */
  windowOpen: boolean;
  /** proportional share of what was paid for the tickets */
  grossCents: number;
  /** kept by the platform: 2% of the refund, min 50 cents */
  feeCents: number;
  /** what actually goes back to the customer */
  netCents: number;
  /** seats go back on sale only while the window is open */
  releasesSeats: boolean;
}

/** A cancellation of some of an order's tickets. */
export interface CancellationQuote extends CancellationPreview {
  /** how many tickets this cancellation gives back */
  tickets: number;
}

/** What every earlier cancellation on an order adds up to. */
export interface RefundsSoFar {
  ticketsCancelled: number;
  /** gross refunded so far: fees included, before they were kept */
  grossCents: number;
  /** refund fees kept so far */
  feeCents: number;
}

export const NOTHING_REFUNDED: RefundsSoFar = { ticketsCancelled: 0, grossCents: 0, feeCents: 0 };

/** Running totals over an order's refunds. */
export function refundsSoFar(refunds: readonly { tickets: number; grossCents: number; feeCents: number }[]): RefundsSoFar {
  return refunds.reduce(
    (sum, r) => ({
      ticketsCancelled: sum.ticketsCancelled + r.tickets,
      grossCents: sum.grossCents + r.grossCents,
      feeCents: sum.feeCents + r.feeCents,
    }),
    NOTHING_REFUNDED,
  );
}

/** The RangeError message of a partial cancel asked for after the event started. */
export const PARTIAL_CANCEL_CLOSED = "partial cancel after the event has started";

function checkSoFar(order: Order, soFar: RefundsSoFar): void {
  const { ticketsCancelled, grossCents, feeCents } = soFar;
  if (!Number.isInteger(ticketsCancelled) || ticketsCancelled < 0 || ticketsCancelled > order.tickets) {
    throw new RangeError("tickets cancelled so far out of range");
  }
  if (!Number.isSafeInteger(grossCents) || grossCents < 0 || !Number.isSafeInteger(feeCents) || feeCents < 0) {
    throw new RangeError("refunds so far out of range");
  }
}

/**
 * What cancelling `tickets` more of an order's tickets at `nowMs` pays, given
 * the cancellations before it. Priced on running totals, never per cancel:
 *
 *   gross = calculateRefund(all tickets cancelled so far, this one included)
 *           − gross already refunded
 *   fee   = refundFee(that running gross) − fees already kept
 *
 * so the rounding of each cancel never adds up: any sequence of partial
 * cancels nets exactly what one whole-order cancel would. Neither part is ever
 * negative, and the fee never exceeds the gross.
 *
 * From the event start on only a full cancel is left — every ticket still on
 * the order, which pays nothing and keeps the seats, as it always did.
 * Cancelling just some of them then is refused (PARTIAL_CANCEL_CLOSED).
 */
export function quoteCancellation(order: Order, soFar: RefundsSoFar, tickets: number, nowMs: number): CancellationQuote {
  checkSoFar(order, soFar);
  if (!Number.isInteger(tickets) || tickets < 1 || tickets > order.tickets - soFar.ticketsCancelled) {
    throw new RangeError("tickets to cancel out of range");
  }
  const windowOpen = nowMs < order.eventStartMs;
  if (!windowOpen && tickets < order.tickets - soFar.ticketsCancelled) throw new RangeError(PARTIAL_CANCEL_CLOSED);
  const runningGross = calculateRefund(order, soFar.ticketsCancelled + tickets, nowMs);
  const grossCents = Math.max(0, runningGross - soFar.grossCents);
  const feeCents = Math.min(grossCents, refundFee(grossCents));
  return { tickets, windowOpen, grossCents, feeCents, netCents: grossCents - feeCents, releasesSeats: windowOpen };
}

/** What cancelling a whole order at `nowMs` pays and does to inventory. */
export function previewCancellation(order: Order, nowMs: number): CancellationPreview {
  const { tickets: _all, ...preview } = quoteCancellation(order, NOTHING_REFUNDED, order.tickets, nowMs);
  return preview;
}

/** What an event cancellation pays on one order. */
export interface EventCancellationRefund {
  /** the tickets the customer still holds */
  tickets: number;
  grossCents: number;
  /** always 0: the customer did nothing wrong */
  feeCents: number;
  netCents: number;
}

/**
 * The organiser cancels the event: the customer gets the ticket amount for
 * the tickets they still hold — what was paid less the share of the tickets
 * already cancelled — with no fee. Fees kept on earlier partial cancels stay
 * kept. The gross over every refund of the order never exceeds `totalCents`.
 */
export function eventCancellationRefund(order: Order, soFar: RefundsSoFar): EventCancellationRefund {
  checkSoFar(order, soFar);
  const held = order.totalCents - paidShare(order, soFar.ticketsCancelled);
  const grossCents = Math.max(0, Math.min(held, order.totalCents - soFar.grossCents));
  return { tickets: order.tickets - soFar.ticketsCancelled, grossCents, feeCents: 0, netCents: grossCents };
}
