// Order use cases: the seam between the domain rules, the database and the
// payment provider. Framework-free — server actions call these with the real
// clock, tests call them with any clock they like.
import { randomUUID } from "node:crypto";
import { bookTickets, seatsAvailable } from "../domain/booking";
import { eventCancellationRefund, PARTIAL_CANCEL_CLOSED, quoteCancellation, refundsSoFar, type CancellationQuote } from "../domain/cancellation";
import { checkDiscountCode, normalizeCode, quote, type CodeCheck } from "../domain/pricing";
import type { Invoice } from "../domain/invoice";
import type { Db } from "../db/client";
import { claimCheckout, releaseCheckout } from "../db/checkout-claims-repo";
import { isChargeVoided, lockCheckoutKey, recordVoid } from "../db/voided-charges-repo";
import { getCode, getCodeForUpdate, incrementUses, toDomainCode } from "../db/codes-repo";
import { adjustSeatsSold, getEvent, getEventForUpdate, markEventCancelled, toDomainEvent } from "../db/events-repo";
import {
  getOrder,
  getOrderByIdempotencyKey,
  isOrderId,
  listPaidOrdersForUpdate,
  getOrderWithEvent,
  getOrderWithEventForUpdate,
  insertOrder,
  markRefunded,
  toDomainOrder,
} from "../db/orders-repo";
import {
  getRefundByIdempotencyKey,
  insertRefund,
  listEventCancelRefunds,
  listRefundsForOrder,
  listRefundsForOrders,
  listUnpaidCustomerRefunds,
  listUnpaidEventCancelRefunds,
  owed,
  setProviderRefundId,
} from "../db/refunds-repo";
import type { EventRow, OrderRow, RefundRow } from "../db/schema";
import type { PaymentProvider } from "../payments";

export interface Deps {
  db: Db;
  payments: PaymentProvider;
  /** "now" in ms since epoch — injected so every rule about time is testable */
  nowMs: number;
}

/**
 * Run a transaction, re-running it when Postgres aborts it to break a deadlock
 * (SQLSTATE 40P01). Cancels take event → order locks everywhere, so this is a
 * safety net rather than the expected path. Each attempt re-reads its rows, so a
 * retry decides on the committed state; after the last attempt the caller
 * gets a readable refusal instead of a raw driver error.
 */
async function withDeadlockRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (e) {
      const code = (e as { code?: string; cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
      if (code !== "40P01") throw e;
      if (i >= attempts) throw new OrderError("Another change to this order or event happened at the same moment. Try again.");
    }
  }
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

/** A claim older than this belongs to a checkout that crashed; it may be taken over. */
const CLAIM_STALE_MS = 5 * 60_000;
/** How long a second attempt with the same key waits for the first to finish. */
const CLAIM_WAIT_MS = 15_000;
const CLAIM_POLL_MS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A refund with a few quick retries for provider blips. False if it never got through. */
async function refundWithRetry(payments: PaymentProvider, chargeId: string, cents: number, key: string): Promise<boolean> {
  for (const waitMs of [0, 200, 1000]) {
    if (waitMs) await sleep(waitMs);
    try {
      await payments.refund(chargeId, cents, key);
      return true;
    } catch {
      // try again; the idempotency key means a retry never pays twice
    }
  }
  return false;
}

export async function placeOrder(deps: Deps, input: PlaceOrderInput): Promise<{ order: OrderRow; replayed: boolean }> {
  // Attempts with the same idempotency key never overlap: an agent that times
  // out and resends while its first attempt is still charging the card must
  // see that attempt's outcome (an order, or a voided charge), not race it.
  // The first attempt claims the key with a row; a second one polls — holding
  // no database connection — until the claim is gone, then decides on what
  // the first attempt left behind.
  const token = randomUUID();
  const deadline = Date.now() + CLAIM_WAIT_MS;
  for (;;) {
    const previous = await getOrderByIdempotencyKey(deps.db, input.idempotencyKey);
    if (previous) {
      if (previous.userId !== (input.userId ?? null)) throw new OrderError("This checkout was already used. Start a new one.");
      return { order: previous, replayed: true };
    }
    if (await claimCheckout(deps.db, input.idempotencyKey, token, CLAIM_STALE_MS)) break;
    if (Date.now() >= deadline) {
      throw new OrderError("This checkout is still being processed. Try again in a moment with the same idempotency key.");
    }
    await sleep(CLAIM_POLL_MS);
  }
  try {
    return await placeOrderOnce(deps, input);
  } finally {
    await releaseCheckout(deps.db, input.idempotencyKey, token);
  }
}

async function placeOrderOnce(deps: Deps, input: PlaceOrderInput): Promise<{ order: OrderRow; replayed: boolean }> {
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
  // earlier attempt with this key gave it back, an order on it would be tickets
  // for free. Finish that refund if it never reached the provider (idempotent),
  // then refuse: a new attempt needs a new key.
  const earlierVoid = await isChargeVoided(db, charge.id);
  if (earlierVoid || charge.refundedCents > 0) {
    if (earlierVoid) await payments.refund(charge.id, charge.amountCents, `void-${input.idempotencyKey}`);
    throw new OrderError("An earlier attempt with this checkout failed and was refunded. Start a new checkout (a new idempotency key).");
  }

  try {
    const order = await db.transaction(async (tx) => {
      // Money decisions for this key happen one at a time: never book on a
      // charge another attempt has started to give back.
      await lockCheckoutKey(tx, input.idempotencyKey);
      if (await isChargeVoided(tx, charge.id)) {
        throw new OrderError("An earlier attempt with this checkout failed and was refunded. Start a new checkout (a new idempotency key).");
      }
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
    // The card was charged but this attempt booked nothing. Under the key's
    // lock: if another attempt with this key booked on the charge, it is
    // theirs; otherwise record the void, so no attempt can book on it from
    // now on. Then give the money back — outside any transaction, so a slow
    // payment provider holds no database connection.
    const winner = await db.transaction(async (tx) => {
      await lockCheckoutKey(tx, input.idempotencyKey);
      const booked = await getOrderByIdempotencyKey(tx, input.idempotencyKey);
      if (booked && booked.paymentId === charge.id) return booked;
      await recordVoid(tx, charge.id, input.idempotencyKey, nowMs);
      return null;
    });
    if (winner) {
      if (winner.userId !== (input.userId ?? null)) throw new OrderError("This checkout was already used. Start a new one.");
      return { order: winner, replayed: true };
    }
    // Give the money back, retrying a provider blip a few times. If it still
    // fails, the void stays recorded and the next attempt with this key
    // finishes it; either way the caller hears the real reason (e.g. sold out).
    const refunded = await refundWithRetry(payments, charge.id, charge.amountCents, `void-${input.idempotencyKey}`);
    if (!refunded && e instanceof OrderError) {
      throw new OrderError(`${e.message} Your card was charged; the refund is pending — retry with the same idempotency key to complete it.`);
    }
    throw e;
  }
}

export interface CancelResult {
  /** the order after the cancel: "refunded" once no tickets are left */
  order: OrderRow;
  /** this cancellation */
  refund: RefundRow;
  /** every refund of the order, this one included, oldest first */
  refunds: RefundRow[];
  /** this cancellation's figures, flat: tickets given back, net paid, fee kept */
  tickets: number;
  refundCents: number;
  refundFeeCents: number;
  seatsReleased: boolean;
  /** true when the idempotency key had already cancelled: `refund` is that first cancellation, nothing new */
  replayed: boolean;
}

/** What a cancel would do right now, from the same domain function the cancel uses. */
export interface CancelQuoteResult extends CancellationQuote {
  order: OrderRow;
  /** tickets on the order not cancelled yet, before this cancel */
  ticketsLeft: number;
}

/** "This order has 3 tickets left: cancel 1 to 3." */
function ticketsLeftMessage(left: number): string {
  return left === 1 ? "This order has 1 ticket left: cancel 1." : `This order has ${left} tickets left: cancel 1 to ${left}.`;
}

/**
 * Prices cancelling `tickets` (default: all that are left) of an order with
 * this refund history. The one place both the quote and the cancel decide.
 */
function priceCancel(found: { order: OrderRow; event: EventRow }, history: RefundRow[], tickets: number | undefined, nowMs: number) {
  const soFar = refundsSoFar(history);
  const ticketsLeft = found.order.quantity - soFar.ticketsCancelled;
  if (ticketsLeft === 0) throw new OrderError("This order has already been refunded.");
  const n = tickets ?? ticketsLeft;
  if (!Number.isInteger(n) || n < 1 || n > ticketsLeft) throw new OrderError(ticketsLeftMessage(ticketsLeft));
  try {
    return { ticketsLeft, quote: quoteCancellation(toDomainOrder(found.order, found.event), soFar, n, nowMs) };
  } catch (e) {
    if (e instanceof RangeError && e.message === PARTIAL_CANCEL_CLOSED) {
      const all = ticketsLeft === found.order.quantity ? "the whole order" : `all ${ticketsLeft} tickets left`;
      throw new OrderError(`The event has started: you can no longer cancel only some of the tickets. You can still cancel ${all}, with no refund.`);
    }
    throw e;
  }
}

/**
 * What cancelling `tickets` of an order (default: every ticket left) would pay
 * at `nowMs`. Reads only; the cancel itself re-decides under the order's lock.
 */
export async function quoteCancel(deps: Pick<Deps, "db" | "nowMs">, orderId: number, tickets?: number): Promise<CancelQuoteResult> {
  const found = isOrderId(orderId) ? await getOrderWithEvent(deps.db, orderId) : undefined;
  if (!found) throw new OrderError("Order not found.");
  const { ticketsLeft, quote } = priceCancel(found, await listRefundsForOrder(deps.db, orderId), tickets, deps.nowMs);
  return { ...quote, order: found.order, ticketsLeft };
}

/** quoteCancel for one account: someone else's order is "not found". */
export async function quoteOwnCancel(deps: Pick<Deps, "db" | "nowMs">, userId: string, orderId: number, tickets?: number): Promise<CancelQuoteResult> {
  const found = isOrderId(orderId) ? await getOrder(deps.db, orderId) : undefined;
  if (!found || found.userId !== userId) throw new OrderError("Order not found.");
  return quoteCancel(deps, orderId, tickets);
}

/** The refunds table's key of a cancel that came with the caller's idempotency key. */
const cancelKey = (idempotencyKey: string) => `cancel-${idempotencyKey}`;

const KEY_USED_ELSEWHERE = "This idempotency key was already used for a different cancellation. Use a new key for a new cancellation.";

/**
 * Cancel `tickets` of an order (default: every ticket left), as many times as
 * the customer likes until none are left or the event starts. Each cancel is
 * its own refund row, priced on running totals (quoteCancellation), so any
 * sequence of partial cancels nets what one whole-order cancel would. The
 * service fee is kept. After the event starts only a full cancel is left: the
 * customer is paid nothing AND keeps the seats.
 *
 * `idempotencyKey` (already namespaced per caller, like placeOrder's) makes a
 * resend safe: it is stored with the refund row, and a second cancel with the
 * same key returns the first one's refund and cancels nothing more.
 */
export async function cancelOrder(deps: Deps, orderId: number, tickets?: number, idempotencyKey?: string): Promise<CancelResult> {
  const { db, payments, nowMs } = deps;
  const decided = await withDeadlockRetry(() => db.transaction(async (tx) => {
    // Event first, then the order: the lock order of cancelEvent and of every
    // checkout, so a customer's cancel queues behind an event cancellation
    // instead of deadlocking with it. (An order never changes event.)
    const placed = isOrderId(orderId) ? await getOrder(tx, orderId) : undefined;
    if (!placed) throw new OrderError("Order not found.");
    await getEventForUpdate(tx, placed.eventId);
    // The order lock serialises every cancel of this order: each prices itself on the refunds committed before it.
    const found = (await getOrderWithEventForUpdate(tx, orderId))!;
    if (idempotencyKey !== undefined) {
      // Before every other rule: a resend gets the first answer even when a
      // new cancel would be refused by now (nothing left, the event started).
      const first = await getRefundByIdempotencyKey(tx, cancelKey(idempotencyKey));
      if (first) {
        if (first.orderId !== orderId || (tickets !== undefined && tickets !== first.tickets)) throw new OrderError(KEY_USED_ELSEWHERE);
        return { refundId: first.id, paymentId: found.order.paymentId, replayed: true };
      }
    }
    const history = await listRefundsForOrder(tx, orderId);
    if (found.order.status === "refunded") {
      // Refunded in our books but a payout never reached the provider (it
      // failed last time): pay it now instead of refusing. Each refund's
      // idempotency key makes this safe to run any number of times.
      const unpaid = history.filter((r) => r.reason === "customer" && owed(r));
      if (unpaid.length > 0) return { refundId: unpaid.at(-1)!.id, paymentId: found.order.paymentId, replayed: false };
      throw new OrderError("This order has already been refunded.");
    }
    const { ticketsLeft, quote } = priceCancel(found, history, tickets, nowMs);
    const cancelledAfter = found.order.quantity - ticketsLeft + quote.tickets;
    const refund = await insertRefund(tx, {
      orderId,
      tickets: quote.tickets,
      grossCents: quote.grossCents,
      feeCents: quote.feeCents,
      netCents: quote.netCents,
      reason: "customer",
      createdAtMs: nowMs,
      seatsReleased: quote.releasesSeats,
      // The caller's key, or one unique per cancel: tickets cancelled so far only ever grows.
      idempotencyKey: idempotencyKey !== undefined ? cancelKey(idempotencyKey) : `refund-${orderId}-${cancelledAfter}`,
    });
    if (quote.releasesSeats) await adjustSeatsSold(tx, found.order.eventId, -quote.tickets);
    if (quote.tickets === ticketsLeft) await markRefunded(tx, orderId);
    return { refundId: refund.id, paymentId: found.order.paymentId, replayed: false };
  })).catch((e) => {
    // The same key sent for two orders at the same moment: neither saw the
    // other's row, and the unique key lets only one of them in.
    const cause = (e as { cause?: { code?: string; constraint?: string } }).cause ?? (e as { code?: string; constraint?: string });
    if (cause.code === "23505" && cause.constraint === "refunds_idempotency_key_unique") throw new OrderError(KEY_USED_ELSEWHERE);
    throw e;
  });

  // Pay out — outside the transaction, so a slow provider holds no
  // connection. Every payout this order still owes the customer goes, not
  // just this one: an earlier cancel whose payout failed is paid now too.
  for (const r of await listUnpaidCustomerRefunds(db, orderId)) {
    const paid = await payments.refund(decided.paymentId, r.netCents, r.idempotencyKey);
    await setProviderRefundId(db, r.id, paid.id);
  }
  const order = (await getOrder(db, orderId))!;
  const all = await listRefundsForOrder(db, orderId);
  const refund = all.find((r) => r.id === decided.refundId)!;
  return {
    order,
    refund,
    refunds: all,
    tickets: refund.tickets,
    refundCents: refund.netCents,
    refundFeeCents: refund.feeCents,
    seatsReleased: refund.seatsReleased,
    replayed: decided.replayed,
  };
}

/**
 * Cancel an order on behalf of one account. Someone else's order is "not
 * found" — never "not yours" — so an order number leaks nothing.
 */
export async function cancelOwnOrder(deps: Deps, userId: string, orderId: number, tickets?: number, idempotencyKey?: string): Promise<CancelResult> {
  const found = isOrderId(orderId) ? await getOrder(deps.db, orderId) : undefined;
  if (!found || found.userId !== userId) throw new OrderError("Order not found.");
  return cancelOrder(deps, orderId, tickets, idempotencyKey);
}

export interface CancelEventResult {
  event: EventRow;
  refundedOrders: number;
  refundedCents: number;
}

/**
 * The organiser calls the event off: sales stop and every order with tickets
 * left gets the ticket amount for those tickets back — no refund fee, because
 * the customer did nothing wrong (eventCancellationRefund). Fees kept on
 * earlier partial cancels stay kept, and the service fee stays with the
 * platform, as it does for every refund. Only before the event starts: a show
 * that happened is not refunded wholesale. Admin-only — callers check the role.
 *
 * Money moves in two phases. The transaction writes every refund and marks
 * the event cancelled; then each payout goes to the provider. A payout that
 * fails leaves its refund unpaid (no provider id) — calling cancelEvent again
 * on the cancelled event retries exactly those, and the per-refund
 * idempotency key means nobody is paid twice.
 */
export async function cancelEvent(deps: Deps, eventId: string): Promise<CancelEventResult> {
  const { db, nowMs } = deps;
  await withDeadlockRetry(() => db.transaction(async (tx) => {
    // Event lock first: no checkout can add a paid order behind our back, and a
    // customer cancelling at the same moment waits for us (cancelOrder locks
    // event-then-order too). withDeadlockRetry stays as the safety net.
    const ev = await getEventForUpdate(tx, eventId);
    if (!ev) throw new OrderError("Event not found.");
    if (ev.cancelledAtMs !== null) {
      if ((await listUnpaidEventCancelRefunds(tx, eventId)).length === 0) throw new OrderError("This event is already cancelled.");
      return; // cancelled earlier, some payouts still owed: retry them below
    }
    if (nowMs >= ev.startsAtMs) throw new OrderError("This event has already started — it can no longer be cancelled.");
    await markEventCancelled(tx, eventId, nowMs);
    const paid = await listPaidOrdersForUpdate(tx, eventId);
    const histories = await listRefundsForOrders(tx, paid.map((o) => o.id));
    for (const o of paid) {
      const r = eventCancellationRefund(toDomainOrder(o, ev), refundsSoFar(histories.get(o.id)!));
      await insertRefund(tx, {
        orderId: o.id,
        tickets: r.tickets,
        grossCents: r.grossCents,
        feeCents: r.feeCents,
        netCents: r.netCents,
        reason: "event_cancelled",
        createdAtMs: nowMs,
        seatsReleased: true,
        idempotencyKey: `event-cancel-${o.id}`,
      });
      if (!(await markRefunded(tx, o.id))) throw new OrderError(`Order ${o.id} changed while cancelling. Try again.`);
      await adjustSeatsSold(tx, eventId, -r.tickets);
    }
  }));
  return payCancelRefunds(deps, eventId);
}

/** Pay every refund the cancellation owes and has not paid yet. */
async function payCancelRefunds({ db, payments }: Deps, eventId: string): Promise<CancelEventResult> {
  const ev = (await getEvent(db, eventId))!;
  const owedNow = await listUnpaidEventCancelRefunds(db, eventId);
  let failed = 0;
  for (const { refund, paymentId } of owedNow) {
    try {
      const paid = await payments.refund(paymentId, refund.netCents, refund.idempotencyKey);
      await setProviderRefundId(db, refund.id, paid.id);
    } catch {
      failed++;
    }
  }
  if (failed > 0) {
    throw new OrderError(`The event is cancelled, but ${failed} of ${owedNow.length} refunds failed at the payment provider. Cancel again to retry them.`);
  }
  const all = await listEventCancelRefunds(db, eventId);
  return { event: ev, refundedOrders: all.length, refundedCents: all.reduce((sum, r) => sum + r.refund.netCents, 0) };
}
