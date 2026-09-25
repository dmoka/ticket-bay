// Property tests for cancelEvent (src/services/orders.ts), against a real Postgres.
//
// Invariants, in English — for any mix of orders (any price, quantity, discount
// code up to 100%, early-bird or not), some of them already refunded by the
// customer before or after the event started, and the organiser cancelling at
// any instant BEFORE the start (product decision: a started event cannot be cancelled):
//  1. Every order that was still paid is now refunded, with refund = exactly its
//     ticket amount, refund fee = 0, and the payment provider got exactly that
//     amount back for its charge (nothing for a 0-cent ticket amount).
//  2. No refund is ever above what was paid: refund ≤ ticket amount ≤ total charged,
//     and the provider's refunded total per charge never exceeds the charge.
//  3. Orders the customer had already refunded are untouched.
//  4. The result reconciles: refundedOrders = number of paid orders,
//     refundedCents = sum of their ticket amounts = the impact the admin was shown
//     (cancelImpact) just before confirming.
//  5. Seats: the sold count drops by exactly the paid orders' tickets — every seat
//     a paid order held goes back — and nothing else moves.
//  6. Cancelling twice refunds nothing more, and the event can no longer be quoted or booked.
//  7. From the start instant on, cancelEvent is refused and changes nothing:
//     no order, no seat, no provider refund, the event stays uncancelled.
//  8. When the payment provider fails some payouts, retrying cancelEvent until it
//     succeeds ends with every paid order paid back exactly its ticket amount,
//     exactly once.
import fc from "fast-check";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { cancelImpact } from "../../src/db/admin-queries";
import { createEvent, getEvent } from "../../src/db/events-repo";
import { getOrder } from "../../src/db/orders-repo";
import { discountCodes, events, orders } from "../../src/db/schema";
import { createFakeStripe, PaymentError, type PaymentProvider } from "../../src/payments";
import { cancelEvent, cancelOrder, OrderError, placeOrder, quoteOrder } from "../../src/services/orders";
import { useTestDatabase } from "./database";

const t = useTestDatabase();

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const BASE = Date.UTC(2027, 0, 15, 12);

const orderSpec = fc.record({
  quantity: fc.oneof(fc.constantFrom(1, 4, 5, 9, 10), fc.integer({ min: 1, max: 12 })),
  codePercent: fc.option(fc.oneof(fc.constant(100), fc.integer({ min: 1, max: 100 })), { nil: undefined }),
  /** days before the start the order was placed: on both sides of the 30-day early-bird edge */
  bookedDaysBefore: fc.oneof(fc.integer({ min: 1, max: 60 }), fc.constantFrom(30, 31)),
  /**
   * the customer's own refund, relative to the start ("atCancel" = the very
   * millisecond the organiser cancels); null = never. Refunds planned after the
   * organiser's cancel never happen: the order is still paid then.
   */
  selfRefund: fc.option(
    fc.oneof(fc.constant<"atCancel">("atCancel"), fc.constant(-1), fc.constant(0), fc.integer({ min: -10 * DAY, max: 2 * DAY })),
    { nil: null },
  ),
});

const priceCents = fc.oneof(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 5_000 }).map((n) => n * 10 + 5), fc.integer({ min: 1, max: 5_000_000 }));

const scenario = fc.record({
  priceCents,
  seatsAlreadySold: fc.integer({ min: 0, max: 30 }),
  orders: fc.array(orderSpec, { minLength: 0, maxLength: 6 }),
  /** when the organiser cancels, relative to the start: always before it */
  cancelDelta: fc.oneof(fc.integer({ min: -20 * DAY, max: -1 }), fc.constantFrom(-1, -2, -DAY)),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;

const STARTS_AT = BASE + 70 * DAY;

/**
 * Creates the event, books the orders in time order and applies the customers'
 * own refunds up to `cancelAt`. For a pre-start cancel, `cancelAt` is moved
 * after the last booking (still before the start) so the timeline is real.
 */
async function arrange(s: Scenario, payments: PaymentProvider, cancelAtWanted: number) {
  await t.db.execute(sql`TRUNCATE ${orders}, ${discountCodes}, ${events} RESTART IDENTITY`);
  await createEvent(t.db, {
    id: "ev",
    name: "Prop Night",
    category: "concert",
    venue: "Arena",
    city: "Budapest",
    startsAtMs: STARTS_AT,
    totalSeats: 200,
    seatsSold: s.seatsAlreadySold,
    priceCents: s.priceCents,
    createdAtMs: BASE,
  });
  const booked = [...s.orders].sort((a, b) => b.bookedDaysBefore - a.bookedDaysBefore);
  const made: { id: number; at: number; selfRefund: Scenario["orders"][number]["selfRefund"] }[] = [];
  for (const [i, o] of booked.entries()) {
    const at = STARTS_AT - o.bookedDaysBefore * DAY + i; // distinct instants
    if (o.codePercent !== undefined) await t.db.insert(discountCodes).values({ code: `C${i}`, percent: o.codePercent, createdAtMs: BASE });
    const { order } = await placeOrder(
      { db: t.db, payments, nowMs: at },
      { eventId: "ev", quantity: o.quantity, email: "fan@example.com", name: "Fan", code: o.codePercent ? `C${i}` : "", idempotencyKey: `k${i}` },
    );
    made.push({ id: order.id, at, selfRefund: o.selfRefund });
  }
  const lastBooking = Math.max(BASE, ...made.map((m) => m.at));
  const cancelAt = cancelAtWanted < STARTS_AT ? Math.max(lastBooking + 1, cancelAtWanted) : cancelAtWanted;
  const selfRefunds = made
    .filter((m) => m.selfRefund !== null)
    .map((m) => ({ id: m.id, when: m.selfRefund === "atCancel" ? cancelAt : Math.max(m.at + 1, STARTS_AT + (m.selfRefund as number)) }))
    .filter((x) => x.when <= cancelAt)
    .sort((a, b) => a.when - b.when);
  for (const x of selfRefunds) await cancelOrder({ db: t.db, payments, nowMs: x.when }, x.id);
  const before = await Promise.all(made.map((m) => getOrder(t.db, m.id).then((o) => o!)));
  return { cancelAt, before, paid: before.filter((o) => o.status === "paid") };
}

describe("cancelEvent", () => {
  it(
    "before the start: refunds every paid order exactly its ticket amount, frees exactly their seats, and reconciles with the impact shown",
    async () => {
      await fc.assert(
        fc.asyncProperty(scenario, async (s) => {
          const payments = createFakeStripe("sk_test_property");
          const { cancelAt, before, paid } = await arrange(s, payments, STARTS_AT + s.cancelDelta);
          expect(cancelAt).toBeLessThan(STARTS_AT);
          const soldBefore = (await getEvent(t.db, "ev"))!.seatsSold;
          const impact = await cancelImpact(t.db, "ev");

          const r = await cancelEvent({ db: t.db, payments, nowMs: cancelAt }, "ev");

          // 4. reconciliation
          const paidTickets = paid.reduce((n, o) => n + o.ticketsCents, 0);
          const paidSeats = paid.reduce((n, o) => n + o.quantity, 0);
          expect(r.refundedOrders).toBe(paid.length);
          expect(r.refundedCents).toBe(paidTickets);
          expect(impact).toEqual({ orders: paid.length, tickets: paidSeats, refundCents: paidTickets });
          expect(r.event.cancelledAtMs).toBe(cancelAt);

          // 5. seats
          expect(r.event.seatsSold).toBe(soldBefore - paidSeats);
          expect(r.event.seatsSold).toBeGreaterThanOrEqual(s.seatsAlreadySold);

          for (const was of before) {
            const now = (await getOrder(t.db, was.id))!;
            const charge = payments.getCharge(was.paymentId)!;
            // 2. never above what was paid
            expect(now.refundCents!).toBeLessThanOrEqual(now.ticketsCents);
            expect(now.ticketsCents).toBeLessThanOrEqual(now.totalCents);
            expect(charge.refundedCents).toBeLessThanOrEqual(charge.amountCents);
            expect(now.status).toBe("refunded");
            if (was.status === "paid") {
              // 1. exactly the ticket amount, no fee, provider agrees
              expect(now.refundCents).toBe(was.ticketsCents);
              expect(now.refundFeeCents).toBe(0);
              expect(now.seatsReleased).toBe(true);
              expect(charge.refundedCents).toBe(was.ticketsCents);
              expect(now.refundId === null).toBe(was.ticketsCents === 0);
            } else {
              // 3. untouched
              expect(now).toEqual(was);
              expect(charge.refundedCents).toBe(was.refundCents);
            }
          }

          // 6. once only; the event is closed
          await expect(cancelEvent({ db: t.db, payments, nowMs: cancelAt + 1 }, "ev")).rejects.toBeInstanceOf(OrderError);
          for (const was of before) expect(payments.getCharge(was.paymentId)!.refundedCents).toBe((await getOrder(t.db, was.id))!.refundCents);
          await expect(quoteOrder({ db: t.db, nowMs: cancelAt + 1 }, "ev", 1)).rejects.toBeInstanceOf(OrderError);
          await expect(
            placeOrder({ db: t.db, payments, nowMs: cancelAt + 1 }, { eventId: "ev", quantity: 1, email: "late@example.com", name: "Late", idempotencyKey: "late" }),
          ).rejects.toBeInstanceOf(OrderError);
        }),
        { numRuns: 60 },
      );
    },
    300_000,
  );

  it(
    "from the start instant on: refused, and nothing changes — orders, seats, provider, event",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          scenario,
          fc.oneof(fc.constantFrom(0, 1), fc.integer({ min: 0, max: 5 * DAY })),
          async (s, afterStart) => {
            const payments = createFakeStripe("sk_test_property");
            const { cancelAt, before } = await arrange(s, payments, STARTS_AT + afterStart);
            const evBefore = (await getEvent(t.db, "ev"))!;
            const refundedBefore = before.map((o) => payments.getCharge(o.paymentId)!.refundedCents);

            await expect(cancelEvent({ db: t.db, payments, nowMs: cancelAt }, "ev")).rejects.toBeInstanceOf(OrderError);

            expect(await getEvent(t.db, "ev")).toEqual(evBefore);
            expect(evBefore.cancelledAtMs).toBeNull();
            for (const [i, was] of before.entries()) {
              expect(await getOrder(t.db, was.id)).toEqual(was);
              expect(payments.getCharge(was.paymentId)!.refundedCents).toBe(refundedBefore[i]);
            }
          },
        ),
        { numRuns: 40 },
      );
    },
    300_000,
  );

  it(
    "a provider that fails some payouts: retrying until it succeeds pays every paid order its ticket amount exactly once",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          scenario,
          fc.array(fc.boolean(), { maxLength: 12 }),
          fc.array(fc.oneof(fc.integer({ min: 1, max: DAY }), fc.integer({ min: 1, max: 30 * DAY })), { minLength: 13, maxLength: 13 }),
          async (s, failures, retryGaps) => {
            const inner = createFakeStripe("sk_test_property");
            let call = 0;
            const flaky: PaymentProvider = {
              charge: (x) => inner.charge(x),
              getCharge: (id) => inner.getCharge(id),
              async refund(chargeId, amount, key) {
                if (key.startsWith("event-cancel-") && failures[call++]) throw new PaymentError("provider down", "no_such_charge");
                return inner.refund(chargeId, amount, key);
              },
            };
            const { cancelAt, before, paid } = await arrange(s, flaky, STARTS_AT + s.cancelDelta);

            // Retry the way the admin would, at later instants (possibly after the start).
            let at = cancelAt;
            let result: Awaited<ReturnType<typeof cancelEvent>> | undefined;
            for (let attempt = 0; attempt <= failures.length && !result; attempt++) {
              try {
                result = await cancelEvent({ db: t.db, payments: flaky, nowMs: at }, "ev");
              } catch (e) {
                expect(e).toBeInstanceOf(OrderError);
                at += retryGaps[attempt];
              }
            }
            expect(result, "cancelEvent never succeeded although the provider recovered").toBeDefined();

            expect(result!.refundedOrders).toBe(paid.length);
            expect(result!.refundedCents).toBe(paid.reduce((n, o) => n + o.ticketsCents, 0));
            for (const was of before) {
              const now = (await getOrder(t.db, was.id))!;
              const charge = inner.getCharge(was.paymentId)!;
              if (was.status === "paid") {
                expect(now.refundCents).toBe(was.ticketsCents);
                expect(charge.refundedCents).toBe(was.ticketsCents);
                expect(now.refundId === null).toBe(was.ticketsCents === 0);
              } else {
                expect(now).toEqual(was);
                expect(charge.refundedCents).toBe(was.refundCents);
              }
            }
          },
        ),
        { numRuns: 40 },
      );
    },
    300_000,
  );
});
