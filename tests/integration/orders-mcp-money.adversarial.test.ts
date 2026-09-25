// ADVERSARIAL: money paths added for module 6 — placeOrder with userId and
// idempotency, cancelOwnOrder (IDOR), cancelEvent (admin refund-everyone) and
// the races between them. Real Postgres, fake Stripe. Source is read-only;
// every expectation here is the contract a customer or the business relies on.
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { getEvent } from "../../src/db/events-repo";
import { getOrder } from "../../src/db/orders-repo";
import { user } from "../../src/db/schema";
import { createFakeStripe, type PaymentProvider } from "../../src/payments";
import { cancelEvent, cancelOwnOrder, OrderError, placeOrder, type Deps } from "../../src/services/orders";
import { useTestDatabase } from "./database";
import { chargesTogether, DAY, HOUR, NOW, venue } from "./fixtures";

const t = useTestDatabase();

async function newUser(name = "Fan"): Promise<string> {
  const id = `u_${randomUUID().slice(0, 12)}`;
  await t.db.insert(user).values({ id, name, email: `${id}@example.com` });
  return id;
}

function deps(payments: PaymentProvider, nowMs = NOW): Deps {
  return { db: t.db, payments, nowMs };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrderError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("ADVERSARIAL idempotency: a retried booking must never be free", () => {
  it("retrying a failed book_tickets with the same idempotency key does not create a paid order on a voided charge", async () => {
    // book_tickets tells agents: "Pass the same idempotency_key when retrying".
    // First attempt: charged, then the seats are gone inside the transaction,
    // so the charge is voided (refunded in full). Seats come back later and
    // the agent retries with the SAME key.
    const payments = createFakeStripe("sk_test_adv");
    const uid = await newUser();
    const ev = await venue(t.db, { totalSeats: 10, seatsSold: 8 });
    const key = `mcp:${uid}:retry-1`;
    const input = { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "Fan", userId: uid, idempotencyKey: key };

    // Make the first attempt lose the seats between quote and transaction.
    const racing: PaymentProvider = {
      ...payments,
      async charge(i) {
        const c = await payments.charge(i);
        await t.db.execute(sql`UPDATE events SET seats_sold = total_seats WHERE id = ${ev.id}`);
        return c;
      },
      refund: (...a) => payments.refund(...a),
      getCharge: (id) => payments.getCharge(id),
    };
    await refusal(placeOrder(deps(racing), input));

    // Seats free up again; the agent retries with the same key.
    await t.db.execute(sql`UPDATE events SET seats_sold = 8 WHERE id = ${ev.id}`);
    let order;
    try {
      order = (await placeOrder(deps(payments), input)).order;
    } catch {
      return; // refusing the retry is acceptable — handing out tickets is not
    }
    const charge = payments.getCharge(order.paymentId)!;
    // A paid order must be backed by money we actually kept.
    expect(charge.amountCents - charge.refundedCents).toBe(order.totalCents);
  });

  it("two concurrent submits with the same key for the same user: one order, and its charge is NOT refunded", async () => {
    const payments = chargesTogether(2, createFakeStripe("sk_test_adv"));
    const uid = await newUser();
    const ev = await venue(t.db);
    const input = { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "Fan", userId: uid, idempotencyKey: `mcp:${uid}:dbl` };

    const results = await Promise.allSettled([placeOrder(deps(payments), input), placeOrder(deps(payments), input)]);
    const orders = await t.db.execute(sql`SELECT id, payment_id, total_cents FROM orders`);
    expect(orders.rows).toHaveLength(1);
    const row = orders.rows[0] as { payment_id: string; total_cents: string };
    const charge = payments.getCharge(row.payment_id)!;
    // The customer holds a paid order: the money must still be with us.
    expect(charge.refundedCents).toBe(0);
    // And the double submit should look like a replay, not a crash.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
  });

  it("another user cannot replay (or read) someone's order by guessing their key", async () => {
    const payments = createFakeStripe("sk_test_adv");
    const a = await newUser("Alice");
    const b = await newUser("Bob");
    const ev = await venue(t.db);
    await placeOrder(deps(payments), { eventId: ev.id, quantity: 1, email: "a@example.com", name: "A", userId: a, idempotencyKey: "web-k1" });
    const msg = await refusal(
      placeOrder(deps(payments), { eventId: ev.id, quantity: 1, email: "b@example.com", name: "B", userId: b, idempotencyKey: "web-k1" }),
    );
    expect(msg).toMatch(/already used/i);
    // and an account cannot claim a legacy (userId null) order either
    await placeOrder(deps(payments), { eventId: ev.id, quantity: 1, email: "old@example.com", name: "Old", idempotencyKey: "legacy-k" });
    await refusal(
      placeOrder(deps(payments), { eventId: ev.id, quantity: 1, email: "b@example.com", name: "B", userId: b, idempotencyKey: "legacy-k" }),
    );
  });
});

describe("ADVERSARIAL cancelOwnOrder: another customer's order is never reachable", () => {
  it("refuses someone else's order, legacy orders, and junk ids — and moves no money", async () => {
    const payments = createFakeStripe("sk_test_adv");
    const a = await newUser("Alice");
    const b = await newUser("Bob");
    const ev = await venue(t.db);
    const { order } = await placeOrder(deps(payments), {
      eventId: ev.id, quantity: 2, email: "a@example.com", name: "A", userId: a, idempotencyKey: "a-1",
    });
    const { order: legacy } = await placeOrder(deps(payments), {
      eventId: ev.id, quantity: 1, email: "b@example.com", name: "B", idempotencyKey: "legacy-1",
    });

    expect(await refusal(cancelOwnOrder(deps(payments), b, order.id))).toBe("Order not found.");
    expect(await refusal(cancelOwnOrder(deps(payments), b, legacy.id))).toBe("Order not found.");
    for (const junk of [NaN, Infinity, -order.id, order.id + 0.5, 2 ** 53, 0]) {
      expect(await refusal(cancelOwnOrder(deps(payments), b, junk))).toBe("Order not found.");
    }
    // An empty-string user id must not match a null owner.
    expect(await refusal(cancelOwnOrder(deps(payments), "", legacy.id))).toBe("Order not found.");
    expect((await getOrder(t.db, order.id))!.status).toBe("paid");
    expect(payments.getCharge(order.paymentId)!.refundedCents).toBe(0);
  });
});

describe("ADVERSARIAL cancelEvent: refund everyone, exactly once, only when it makes sense", () => {
  it("refuses to cancel an event that has already taken place (it would refund a finished show in full)", async () => {
    const payments = createFakeStripe("sk_test_adv");
    const uid = await newUser();
    const ev = await venue(t.db);
    const { order } = await placeOrder(deps(payments), {
      eventId: ev.id, quantity: 4, email: "a@example.com", name: "A", userId: uid, idempotencyKey: "past-1",
    });
    // The show happened yesterday.
    await refusal(cancelEvent(deps(payments, ev.startsAtMs + DAY), ev.id));
    expect((await getOrder(t.db, order.id))!.status).toBe("paid");
    expect(payments.getCharge(order.paymentId)!.refundedCents).toBe(0);
  });

  it("refuses a second cancel, and a cancelled event can no longer be booked or quoted", async () => {
    const payments = createFakeStripe("sk_test_adv");
    const uid = await newUser();
    const ev = await venue(t.db);
    await cancelEvent(deps(payments), ev.id);
    expect(await refusal(cancelEvent(deps(payments), ev.id))).toMatch(/already cancelled/);
    await refusal(placeOrder(deps(payments), { eventId: ev.id, quantity: 1, email: "a@example.com", name: "A", userId: uid, idempotencyKey: "after-1" }));
    expect(await refusal(cancelEvent(deps(payments), "no-such-event"))).toMatch(/not found/i);
  });

  it("refunds each paid order its full ticket amount; already-refunded orders get nothing more", async () => {
    const payments = createFakeStripe("sk_test_adv");
    const a = await newUser();
    const b = await newUser();
    const ev = await venue(t.db, { priceCents: 3333 });
    const o1 = (await placeOrder(deps(payments), { eventId: ev.id, quantity: 3, email: "a@example.com", name: "A", userId: a, idempotencyKey: "e-1" })).order;
    const o2 = (await placeOrder(deps(payments), { eventId: ev.id, quantity: 1, email: "b@example.com", name: "B", userId: b, idempotencyKey: "e-2" })).order;
    const self = await cancelOwnOrder(deps(payments), b, o2.id);

    const r = await cancelEvent(deps(payments, NOW + HOUR), ev.id);
    expect(r.refundedOrders).toBe(1);
    expect(r.refundedCents).toBe(o1.ticketsCents);
    expect(payments.getCharge(o1.paymentId)!.refundedCents).toBe(o1.ticketsCents);
    expect(payments.getCharge(o2.paymentId)!.refundedCents).toBe(self.refundCents);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(ev.seatsSold);
  });

  it("a payment failure part-way through can be retried until every customer is paid", async () => {
    const inner = createFakeStripe("sk_test_adv");
    let failNext = false;
    const flaky: PaymentProvider = {
      ...inner,
      charge: (i) => inner.charge(i),
      async refund(id, cents, key) {
        if (failNext) {
          failNext = false;
          throw new Error("processor timeout");
        }
        return inner.refund(id, cents, key);
      },
      getCharge: (id) => inner.getCharge(id),
    };
    const ev = await venue(t.db);
    const placed = [];
    for (let i = 0; i < 3; i++) {
      const uid = await newUser();
      placed.push((await placeOrder(deps(flaky), { eventId: ev.id, quantity: 1, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `pf-${i}` })).order);
    }
    failNext = true; // the first payout times out
    await expect(cancelEvent(deps(flaky), ev.id)).rejects.toThrow();

    // The admin retries. Whatever the API shape, every ticket holder must end up paid.
    await cancelEvent(deps(flaky), ev.id).catch(() => undefined);
    for (const o of placed) {
      expect(inner.getCharge(o.paymentId)!.refundedCents, `order ${o.id} was marked refunded but never paid`).toBe(o.ticketsCents);
    }
  });

  it("cancelEvent racing a customer's own refund: each order is paid out once, never above what was charged", async () => {
    const payments = createFakeStripe("sk_test_adv");
    const uid = await newUser();
    const ev = await venue(t.db);
    const { order } = await placeOrder(deps(payments), { eventId: ev.id, quantity: 2, email: "a@example.com", name: "A", userId: uid, idempotencyKey: "race-1" });
    const results = await Promise.allSettled([cancelEvent(deps(payments), ev.id), cancelOwnOrder(deps(payments), uid, order.id)]);
    // Retry whichever side lost (the service says "the caller can retry").
    if (results[0].status === "rejected") await cancelEvent(deps(payments), ev.id).catch(() => undefined);
    const row = (await getOrder(t.db, order.id))!;
    expect(row.status).toBe("refunded");
    const charge = payments.getCharge(order.paymentId)!;
    expect(charge.refundedCents).toBe(row.refundCents);
    expect(charge.refundedCents).toBeLessThanOrEqual(order.ticketsCents);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(ev.seatsSold);
    // A lost race must surface as a readable refusal, not a raw database error.
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(OrderError);
  });

  it("cancelEvent racing a checkout: the checkout ends with no order and its charge voided", async () => {
    const inner = createFakeStripe("sk_test_adv");
    let charged!: () => void;
    const chargedP = new Promise<void>((r) => (charged = r));
    let go!: () => void;
    const goP = new Promise<void>((r) => (go = r));
    const paused: PaymentProvider = {
      ...inner,
      async charge(i) {
        const c = await inner.charge(i);
        charged();
        await goP;
        return c;
      },
      refund: (...a) => inner.refund(...a),
      getCharge: (id) => inner.getCharge(id),
    };
    const uid = await newUser();
    const ev = await venue(t.db);
    const checkout = placeOrder(deps(paused), { eventId: ev.id, quantity: 2, email: "a@example.com", name: "A", userId: uid, idempotencyKey: "co-1" });
    await chargedP;
    await cancelEvent(deps(inner), ev.id);
    go();
    await refusal(checkout);
    const rows = await t.db.execute(sql`SELECT count(*)::int AS n FROM orders`);
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });
});
