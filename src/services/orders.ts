// Order use cases: the seam between the domain rules, the database and the
// payment provider. Framework-free — server actions call these with the real
// clock, tests call them with any clock they like.
import { bookTickets, seatsAvailable } from "../domain/booking";
import { previewCancellation } from "../domain/cancellation";
import { checkDiscountCode, normalizeCode, quote, type CodeCheck } from "../domain/pricing";
import type { Invoice } from "../domain/invoice";
import type { Db } from "../db/client";
import { getCode, incrementUses, toDomainCode } from "../db/codes-repo";
import { adjustSeatsSold, getEvent, toDomainEvent } from "../db/events-repo";
import {
  getOrderByIdempotencyKey,
  getOrderWithEvent,
  insertOrder,
  markRefunded,
  setRefundId,
  toDomainOrder,
} from "../db/orders-repo";
import type { EventRow, OrderRow } from "../db/schema";
import type { PaymentProvider } from "../payments";

export interface Deps {
  db: Db;
  payments: PaymentProvider;
  /** "now" in ms since epoch — injected so every rule about time is testable */
  nowMs: number;
}

/** A refusal the customer should read, as opposed to a bug. */
export class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderError";
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function describeRangeError(e: unknown, ev: EventRow): never {
  if (e instanceof RangeError) {
    if (e.message === "not enough seats") {
      const left = seatsAvailable(toDomainEvent(ev));
      throw new OrderError(left === 0 ? "Sold out — not enough seats left." : `Not enough seats — only ${left} left.`);
    }
    if (e.message === "event has already started") throw new OrderError("Sales are closed — this event has already started.");
    if (e.message === "must book at least one whole ticket") throw new OrderError("Choose at least one ticket.");
    throw new OrderError(`Cannot book this order: ${e.message}.`);
  }
  throw e;
}

export interface QuoteResult {
  invoice: Invoice;
  code: { code: string; percent: number } | null;
}

/** Whether a code the customer typed applies right now. */
export function checkCode(deps: Pick<Deps, "db" | "nowMs">, rawCode: string): CodeCheck {
  const found = getCode(deps.db, normalizeCode(rawCode));
  return checkDiscountCode(rawCode, found && toDomainCode(found), deps.nowMs);
}

/** Price a prospective order. Throws OrderError with a customer-facing reason. */
export function quoteOrder(deps: Pick<Deps, "db" | "nowMs">, eventId: string, quantity: number, rawCode = ""): QuoteResult {
  const ev = getEvent(deps.db, eventId);
  if (!ev) throw new OrderError("Event not found.");
  let code: QuoteResult["code"] = null;
  if (rawCode.trim()) {
    const check = checkCode(deps, rawCode);
    if (!check.ok) throw new OrderError(check.reason);
    code = { code: check.code, percent: check.percent };
  }
  try {
    return { invoice: quote(toDomainEvent(ev), quantity, deps.nowMs, code?.percent ?? 0), code };
  } catch (e) {
    describeRangeError(e, ev);
  }
}

export interface PlaceOrderInput {
  eventId: string;
  quantity: number;
  email: string;
  name: string;
  code?: string;
  /** one per checkout page view — a double submit must not charge twice */
  idempotencyKey: string;
}

export async function placeOrder(deps: Deps, input: PlaceOrderInput): Promise<{ order: OrderRow; replayed: boolean }> {
  const { db, payments, nowMs } = deps;
  const previous = getOrderByIdempotencyKey(db, input.idempotencyKey);
  if (previous) return { order: previous, replayed: true };

  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!EMAIL.test(email)) throw new OrderError("Enter a valid email address.");
  if (!name) throw new OrderError("Enter the name for the tickets.");

  const { invoice, code } = quoteOrder(deps, input.eventId, input.quantity, input.code);
  const ev = getEvent(db, input.eventId)!;

  const charge = await payments.charge({
    amountCents: invoice.totalCents,
    currency: "eur",
    idempotencyKey: input.idempotencyKey,
    description: `${input.quantity} x ${ev.name}`,
  });

  try {
    const order = db.transaction((tx) => {
      // Re-check against the row as it is NOW: another checkout may have taken
      // the last seats while the card was being charged.
      const fresh = getEvent(tx, input.eventId)!;
      try {
        bookTickets(toDomainEvent(fresh), input.quantity);
      } catch (e) {
        describeRangeError(e, fresh);
      }
      if (code) {
        const c = getCode(tx, code.code);
        const check = checkDiscountCode(code.code, c && toDomainCode(c), nowMs);
        if (!check.ok) throw new OrderError(check.reason);
        incrementUses(tx, code.code);
      }
      adjustSeatsSold(tx, input.eventId, input.quantity);
      return insertOrder(tx, {
        eventId: input.eventId,
        customerEmail: email,
        customerName: name,
        quantity: input.quantity,
        subtotalCents: invoice.subtotalCents,
        discountPercent: invoice.discountPercent,
        groupPercent: invoice.groupPercent,
        earlyBirdPercent: invoice.earlyBirdPercent,
        codePercent: invoice.codePercent,
        discountCode: code?.code ?? null,
        discountCents: invoice.discountCents,
        ticketsCents: invoice.ticketsCents,
        feeCents: invoice.feeCents,
        totalCents: invoice.totalCents,
        vatCents: invoice.vatCents,
        paymentId: charge.id,
        idempotencyKey: input.idempotencyKey,
        createdAtMs: nowMs,
      });
    });
    return { order, replayed: false };
  } catch (e) {
    // The card was charged but no order exists: give the money back.
    await payments.refund(charge.id, charge.amountCents, `void-${input.idempotencyKey}`);
    throw e;
  }
}

export interface CancelResult {
  order: OrderRow;
  refundCents: number;
  refundFeeCents: number;
  seatsReleased: boolean;
}

/**
 * Cancel a whole order. Refund = the refund module's net amount on what was
 * paid for the tickets (the service fee is kept). Seats go back on sale only
 * while the refund window is open — after the event starts the customer is
 * paid nothing AND keeps the seat.
 */
export async function cancelOrder(deps: Deps, orderId: number): Promise<CancelResult> {
  const { db, payments, nowMs } = deps;
  const result = db.transaction((tx) => {
    const found = getOrderWithEvent(tx, orderId);
    if (!found) throw new OrderError("Order not found.");
    if (found.order.status === "refunded") throw new OrderError("This order has already been refunded.");
    const preview = previewCancellation(toDomainOrder(found.order, found.event), nowMs);
    const won = markRefunded(tx, orderId, {
      atMs: nowMs,
      refundCents: preview.netCents,
      refundFeeCents: preview.feeCents,
      seatsReleased: preview.releasesSeats,
    });
    if (!won) throw new OrderError("This order has already been refunded.");
    if (preview.releasesSeats) adjustSeatsSold(tx, found.order.eventId, -found.order.quantity);
    return { paymentId: found.order.paymentId, preview };
  });

  if (result.preview.netCents > 0) {
    const refund = await payments.refund(result.paymentId, result.preview.netCents, `refund-${orderId}`);
    setRefundId(db, orderId, refund.id);
  }
  const after = getOrderWithEvent(db, orderId)!;
  return {
    order: after.order,
    refundCents: result.preview.netCents,
    refundFeeCents: result.preview.feeCents,
    seatsReleased: result.preview.releasesSeats,
  };
}
