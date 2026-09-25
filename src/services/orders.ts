// Order use cases: the seam between the domain rules, the database and the
// payment provider. Framework-free — server actions call these with the real
// clock, tests call them with any clock they like.
import { bookTickets, seatsAvailable } from "../domain/booking";
import { previewCancellation } from "../domain/cancellation";
import { checkDiscountCode, normalizeCode, quote, type CodeCheck } from "../domain/pricing";
import type { Invoice } from "../domain/invoice";
import type { Db } from "../db/client";
import { getCode, getCodeForUpdate, incrementUses, toDomainCode } from "../db/codes-repo";
import { adjustSeatsSold, getEvent, getEventForUpdate, markEventCancelled, toDomainEvent } from "../db/events-repo";
import {
  getOrder,
  getOrderByIdempotencyKey,
  isOrderId,
  listCancelRefunds,
  listPaidOrdersForUpdate,
  listUnpaidCancelRefunds,
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
export async function checkCode(deps: Pick<Deps, "db" | "nowMs">, rawCode: string): Promise<CodeCheck> {
  const found = await getCode(deps.db, normalizeCode(rawCode));
  return checkDiscountCode(rawCode, found && toDomainCode(found), deps.nowMs);
}

/** Price a prospective order. Throws OrderError with a customer-facing reason. */
export async function quoteOrder(deps: Pick<Deps, "db" | "nowMs">, eventId: string, quantity: number, rawCode = ""): Promise<QuoteResult> {
  const ev = await getEvent(deps.db, eventId);
  if (!ev) throw new OrderError("Event not found.");
  if (ev.cancelledAtMs !== null) throw new OrderError("This event has been cancelled.");
  let code: QuoteResult["code"] = null;
  if (rawCode.trim()) {
    const check = await checkCode(deps, rawCode);
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
  /** the signed-in account placing the order (the app and the MCP server always pass one) */
  userId?: string;
}

export async function placeOrder(deps: Deps, input: PlaceOrderInput): Promise<{ order: OrderRow; replayed: boolean }> {
  const { db, payments, nowMs } = deps;
  const previous = await getOrderByIdempotencyKey(db, input.idempotencyKey);
  if (previous) {
    // A replay only ever returns the caller's own order.
    if (previous.userId !== (input.userId ?? null)) throw new OrderError("This checkout was already used. Start a new one.");
    return { order: previous, replayed: true };
  }

  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!EMAIL.test(email)) throw new OrderError("Enter a valid email address.");
  if (!name) throw new OrderError("Enter the name for the tickets.");

  const { invoice, code } = await quoteOrder(deps, input.eventId, input.quantity, input.code);
  const ev = (await getEvent(db, input.eventId))!;

  const charge = await payments.charge({
    amountCents: invoice.totalCents,
    currency: "eur",
    idempotencyKey: input.idempotencyKey,
    description: `${input.quantity} x ${ev.name}`,
  });
  // Same key, same amount: the provider hands back the ORIGINAL charge. If an
  // earlier attempt with this key failed, that charge was voided — an order on
  // it would be tickets for free. A new attempt needs a new key.
  if (charge.refundedCents > 0) {
    throw new OrderError("An earlier attempt with this checkout failed and was refunded. Start a new checkout (a new idempotency key).");
  }

  try {
    const order = await db.transaction(async (tx) => {
      // Re-check against the row as it is NOW: another checkout may have taken
      // the last seats while the card was being charged. The row lock makes a
      // concurrent checkout for the same event wait here until this one commits.
      const fresh = (await getEventForUpdate(tx, input.eventId))!;
      if (fresh.cancelledAtMs !== null) throw new OrderError("This event has been cancelled.");
      try {
        bookTickets(toDomainEvent(fresh), input.quantity);
      } catch (e) {
        describeRangeError(e, fresh);
      }
      if (code) {
        // Locked after the event, in every checkout: one lock order, no deadlock.
        const c = await getCodeForUpdate(tx, code.code);
        const check = checkDiscountCode(code.code, c && toDomainCode(c), nowMs);
        if (!check.ok) throw new OrderError(check.reason);
        await incrementUses(tx, code.code);
      }
      await adjustSeatsSold(tx, input.eventId, input.quantity);
      return insertOrder(tx, {
        eventId: input.eventId,
        userId: input.userId ?? null,
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
    // Two submits with the same key at once: both got the same charge, one
    // inserted the order, this one lost on the unique key. The charge belongs
    // to the winner's order — voiding it would refund tickets that exist.
    const winner = await getOrderByIdempotencyKey(db, input.idempotencyKey);
    if (winner && winner.paymentId === charge.id) {
      if (winner.userId !== (input.userId ?? null)) throw new OrderError("This checkout was already used. Start a new one.");
      return { order: winner, replayed: true };
    }
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
  const result = await db.transaction(async (tx) => {
    const found = await getOrderWithEvent(tx, orderId);
    if (!found) throw new OrderError("Order not found.");
    if (found.order.status === "refunded") throw new OrderError("This order has already been refunded.");
    const preview = previewCancellation(toDomainOrder(found.order, found.event), nowMs);
    const won = await markRefunded(tx, orderId, {
      atMs: nowMs,
      refundCents: preview.netCents,
      refundFeeCents: preview.feeCents,
      seatsReleased: preview.releasesSeats,
    });
    if (!won) throw new OrderError("This order has already been refunded.");
    if (preview.releasesSeats) await adjustSeatsSold(tx, found.order.eventId, -found.order.quantity);
    return { paymentId: found.order.paymentId, preview };
  });

  if (result.preview.netCents > 0) {
    const refund = await payments.refund(result.paymentId, result.preview.netCents, `refund-${orderId}`);
    await setRefundId(db, orderId, refund.id);
  }
  const after = (await getOrderWithEvent(db, orderId))!;
  return {
    order: after.order,
    refundCents: result.preview.netCents,
    refundFeeCents: result.preview.feeCents,
    seatsReleased: result.preview.releasesSeats,
  };
}

/**
 * Cancel an order on behalf of one account. Someone else's order is "not
 * found" — never "not yours" — so an order number leaks nothing.
 */
export async function cancelOwnOrder(deps: Deps, userId: string, orderId: number): Promise<CancelResult> {
  const found = isOrderId(orderId) ? await getOrder(deps.db, orderId) : undefined;
  if (!found || found.userId !== userId) throw new OrderError("Order not found.");
  return cancelOrder(deps, orderId);
}

export interface CancelEventResult {
  event: EventRow;
  refundedOrders: number;
  refundedCents: number;
}

/**
 * The organiser calls the event off: sales stop and every paid order gets its
 * whole ticket amount back — no refund fee, because the customer did nothing
 * wrong. (The service fee stays with the platform, as it does for every
 * refund; the schema caps a refund at the ticket amount.) Only before the
 * event starts: a show that happened is not refunded wholesale.
 * Admin-only — callers check the role.
 *
 * Money moves in two phases. The transaction marks every order refunded and
 * the event cancelled; then each payout goes to the provider. A payout that
 * fails leaves its order refunded-but-unpaid (no refund id) — calling
 * cancelEvent again on the cancelled event retries exactly those, and the
 * per-order idempotency key means nobody is paid twice.
 */
export async function cancelEvent(deps: Deps, eventId: string): Promise<CancelEventResult> {
  const { db, nowMs } = deps;
  await db.transaction(async (tx) => {
    // Event lock first: no checkout can add a paid order behind our back. A
    // customer refunding at the same moment locks order-then-event; Postgres
    // detects that deadlock and aborts one side, which the caller can retry.
    const ev = await getEventForUpdate(tx, eventId);
    if (!ev) throw new OrderError("Event not found.");
    if (ev.cancelledAtMs !== null) {
      if ((await listUnpaidCancelRefunds(tx, eventId, ev.cancelledAtMs)).length === 0) throw new OrderError("This event is already cancelled.");
      return; // cancelled earlier, some payouts still owed: retry them below
    }
    if (nowMs >= ev.startsAtMs) throw new OrderError("This event has already started — it can no longer be cancelled.");
    await markEventCancelled(tx, eventId, nowMs);
    for (const o of await listPaidOrdersForUpdate(tx, eventId)) {
      const won = await markRefunded(tx, o.id, { atMs: nowMs, refundCents: o.ticketsCents, refundFeeCents: 0, seatsReleased: true });
      if (!won) throw new OrderError(`Order ${o.id} changed while cancelling. Try again.`);
      await adjustSeatsSold(tx, eventId, -o.quantity);
    }
  });
  return payCancelRefunds(deps, eventId);
}

/** Pay every refund the cancellation owes and has not paid yet. */
async function payCancelRefunds({ db, payments }: Deps, eventId: string): Promise<CancelEventResult> {
  const ev = (await getEvent(db, eventId))!;
  const owed = await listUnpaidCancelRefunds(db, eventId, ev.cancelledAtMs!);
  let failed = 0;
  for (const o of owed) {
    try {
      const refund = await payments.refund(o.paymentId, o.refundCents!, `event-cancel-${o.id}`);
      await setRefundId(db, o.id, refund.id);
    } catch {
      failed++;
    }
  }
  if (failed > 0) {
    throw new OrderError(`The event is cancelled, but ${failed} of ${owed.length} refunds failed at the payment provider. Cancel again to retry them.`);
  }
  const all = await listCancelRefunds(db, eventId, ev.cancelledAtMs!);
  return { event: ev, refundedOrders: all.length, refundedCents: all.reduce((sum, o) => sum + (o.refundCents ?? 0), 0) };
}
