// Property tests for cancelEvent (src/services/orders.ts), against a real Postgres.
//
// Invariants, in English — for any mix of orders (any price, quantity, discount
// code up to 100%, early-bird or not), some of them already refunded by the
// customer before or after the event started, and the organiser cancelling at
// any instant (before or after the start):
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
import fc from "fast-check";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { cancelImpact } from "../../src/db/admin-queries";
import { createEvent, getEvent } from "../../src/db/events-repo";
import { getOrder } from "../../src/db/orders-repo";
import { discountCodes, events, orders } from "../../src/db/schema";
import { createFakeStripe } from "../../src/payments";
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
  /** refunded by the customer before the event is cancelled: null = still paid */
  selfRefund: fc.option(fc.oneof(fc.constant(-1), fc.constant(0), fc.integer({ min: -10 * DAY, max: 2 * DAY })), { nil: null }),
});

const scenario = fc.record({
  priceCents: fc.oneof(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 5_000 }).map((n) => n * 10 + 5), fc.integer({ min: 1, max: 5_000_000 })),
  seatsAlreadySold: fc.integer({ min: 0, max: 30 }),
  orders: fc.array(orderSpec, { minLength: 0, maxLength: 6 }),
  /** when the organiser cancels, relative to the start */
  cancelDelta: fc.oneof(fc.integer({ min: -20 * DAY, max: 5 * DAY }), fc.integer({ min: -2, max: 2 })),
});

describe("cancelEvent", () => {
  it(
    "refunds every paid order exactly its ticket amount, frees exactly their seats, and reconciles with the impact shown",
    async () => {
      await fc.assert(
        fc.asyncProperty(scenario, async (s) => {
          await t.db.execute(sql`TRUNCATE ${orders}, ${discountCodes}, ${events} RESTART IDENTITY`);
          const payments = createFakeStripe("sk_test_property");
          const startsAt = BASE + 70 * DAY;
          await createEvent(t.db, {
            id: "ev",
            name: "Prop Night",
            category: "concert",
            venue: "Arena",
            city: "Budapest",
            startsAtMs: startsAt,
            totalSeats: 200,
            seatsSold: s.seatsAlreadySold,
            priceCents: s.priceCents,
            createdAtMs: BASE,
          });

          // Book in time order, then apply the customers' own refunds in time order.
          const booked = [...s.orders].sort((a, b) => b.bookedDaysBefore - a.bookedDaysBefore);
          const ids: { id: number; selfRefund: number | null }[] = [];
          for (const [i, o] of booked.entries()) {
            const at = startsAt - o.bookedDaysBefore * DAY + i; // distinct instants
            if (o.codePercent !== undefined) {
              await t.db.insert(discountCodes).values({ code: `C${i}`, percent: o.codePercent, createdAtMs: BASE });
            }
            const { order } = await placeOrder(
              { db: t.db, payments, nowMs: at },
              { eventId: "ev", quantity: o.quantity, email: "fan@example.com", name: "Fan", code: o.codePercent ? `C${i}` : "", idempotencyKey: `k${i}` },
            );
            ids.push({ id: order.id, selfRefund: o.selfRefund === null ? null : Math.max(at + 1, startsAt + o.selfRefund) });
          }
          const cancelAt = startsAt + s.cancelDelta;
          for (const x of [...ids].filter((x) => x.selfRefund !== null && x.selfRefund < cancelAt).sort((a, b) => a.selfRefund! - b.selfRefund!)) {
            await cancelOrder({ db: t.db, payments, nowMs: x.selfRefund! }, x.id);
          }

          const before = await Promise.all(ids.map((x) => getOrder(t.db, x.id).then((o) => o!)));
          const paid = before.filter((o) => o.status === "paid");
          const soldBefore = (await getEvent(t.db, "ev"))!.seatsSold;
          const impact = await cancelImpact(t.db, "ev");

          const r = await cancelEvent({ db: t.db, payments, nowMs: cancelAt }, "ev");

          // 4. reconciliation
          const paidTickets = paid.reduce((n, o) => n + o.ticketsCents, 0);
          expect(r.refundedOrders).toBe(paid.length);
          expect(r.refundedCents).toBe(paidTickets);
          expect(impact).toEqual({ orders: paid.length, tickets: paid.reduce((n, o) => n + o.quantity, 0), refundCents: paidTickets });
          expect(r.event.cancelledAtMs).toBe(cancelAt);

          // 5. seats
          expect(r.event.seatsSold).toBe(soldBefore - paid.reduce((n, o) => n + o.quantity, 0));
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
          if (cancelAt < startsAt) {
            await expect(quoteOrder({ db: t.db, nowMs: cancelAt + 1 }, "ev", 1)).rejects.toBeInstanceOf(OrderError);
            await expect(
              placeOrder({ db: t.db, payments, nowMs: cancelAt + 1 }, { eventId: "ev", quantity: 1, email: "late@example.com", name: "Late", idempotencyKey: "late" }),
            ).rejects.toBeInstanceOf(OrderError);
          }
        }),
        { numRuns: 60 },
      );
    },
    300_000,
  );
});
