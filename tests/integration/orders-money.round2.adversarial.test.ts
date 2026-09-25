// ADVERSARIAL round 2: the round-1 fixes in src/services/orders.ts —
// the "voided charge" guard and same-key loser path in placeOrder, and the
// resumable two-phase payout in cancelEvent. Real Postgres, fake Stripe.
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { getOrder } from "../../src/db/orders-repo";
import { user } from "../../src/db/schema";
import { createFakeStripe, type Charge, type PaymentProvider } from "../../src/payments";
import { cancelEvent, cancelOwnOrder, OrderError, placeOrder, type Deps } from "../../src/services/orders";
import { useTestDatabase } from "./database";
import { DAY, NOW, venue } from "./fixtures";

const t = useTestDatabase();

async function newUser(): Promise<string> {
  const id = `u_${randomUUID().slice(0, 12)}`;
  await t.db.insert(user).values({ id, name: "Fan", email: `${id}@example.com` });
  return id;
}
const deps = (payments: PaymentProvider, nowMs = NOW): Deps => ({ db: t.db, payments, nowMs });

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

/** A provider whose refunds fail while `failing` returns true for the charge. */
function flaky(inner: PaymentProvider, failing: (chargeId: string) => boolean): PaymentProvider {
  return {
    ...inner,
    charge: (i) => inner.charge(i),
    async refund(id, cents, key) {
      if (failing(id)) throw new Error("processor timeout");
      return inner.refund(id, cents, key);
    },
    getCharge: (id) => inner.getCharge(id),
  };
}

async function book(p: PaymentProvider, eventId: string, uid: string, qty = 1) {
  return (await placeOrder(deps(p), { eventId, quantity: qty, email: `${uid}@example.com`, name: "Fan", userId: uid, idempotencyKey: `k-${randomUUID()}` })).order;
}

describe("ADVERSARIAL round 2: a same-key retry that overlaps a failing first attempt", () => {
  it("never produces a paid order on a charge the first attempt voided", async () => {
    // A timeout retry is sent while the first request is still running (the
    // normal case for 'retry after a timeout'). Both get the SAME charge,
    // untouched. Attempt 1 then finds the event sold out and voids the charge;
    // a seat frees up; attempt 2 books on that voided charge.
    const inner = createFakeStripe("sk_test_adv_r2");
    const uid = await newUser();
    const ev = await venue(t.db, { totalSeats: 10, seatsSold: 8 });
    const key = `mcp:${uid}:overlap`;
    const input = { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "Fan", userId: uid, idempotencyKey: key };

    // Attempt 1's charge is held open; attempt 2 is sent 300 ms later (the
    // "retry after a timeout"). If attempt 2 could overlap, it would charge in
    // that window; with serialization it waits — either way the business rule
    // below must hold. When attempt 1 voids its charge, a seat frees up at that
    // exact moment, so attempt 2 finds room and only the voided-charge guard
    // stands between it and free tickets.
    const firstCharged = gate();
    const release1 = gate();
    let calls = 0;
    const controlled: PaymentProvider = {
      ...inner,
      async charge(i) {
        // A real provider answers with a snapshot (a JSON body), not a live
        // object that later refunds mutate — the fake's shared object hides that.
        const c = { ...(await inner.charge(i)) };
        if (++calls === 1) {
          firstCharged.open();
          await Promise.race([release1.p, new Promise((r) => setTimeout(r, 2_000))]);
        }
        return c;
      },
      async refund(id, cents, key) {
        const r = await inner.refund(id, cents, key);
        if (key.startsWith("void-")) await t.db.execute(sql`UPDATE events SET seats_sold = 8 WHERE id = ${ev.id}`);
        return r;
      },
      getCharge: (id) => inner.getCharge(id),
    };

    const a1 = placeOrder(deps(controlled), input);
    await firstCharged.p;
    const a2 = placeOrder(deps(controlled), input);
    await new Promise((r) => setTimeout(r, 300));
    // Seats are gone while attempt 1 is in its transaction.
    await t.db.execute(sql`UPDATE events SET seats_sold = total_seats WHERE id = ${ev.id}`);
    release1.open();
    await a1.catch(() => undefined);
    const r2 = await a2.catch((e) => e as Error);

    const rows = (await t.db.execute(sql`SELECT payment_id, total_cents FROM orders`)).rows as { payment_id: string; total_cents: string }[];
    for (const o of rows) {
      const c = inner.getCharge(o.payment_id) as Charge;
      expect(c.amountCents - c.refundedCents, `paid order on charge ${c.id} with ${c.refundedCents} refunded (attempt 2: ${r2 instanceof Error ? r2.message : "booked"})`).toBe(Number(o.total_cents));
    }
  });

  it("two different users racing on one key: the loser gets neither the winner's order nor a void of the winner's charge", async () => {
    const inner = createFakeStripe("sk_test_adv_r2");
    const a = await newUser();
    const b = await newUser();
    const ev = await venue(t.db);
    const both = gate();
    let n = 0;
    const together: PaymentProvider = {
      ...inner,
      async charge(i) {
        const c = await inner.charge(i);
        if (++n === 2) both.open();
        // Same-key checkouts are serialized by design; release on a timer too.
        await Promise.race([both.p, new Promise((r) => setTimeout(r, 300))]);
        return c;
      },
      refund: (...x) => inner.refund(...x),
      getCharge: (id) => inner.getCharge(id),
    };
    const key = "shared-web-key";
    const mk = (uid: string) => placeOrder(deps(together), { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: key });
    const [ra, rb] = await Promise.allSettled([mk(a), mk(b)]);
    const rows = (await t.db.execute(sql`SELECT user_id, payment_id FROM orders`)).rows as { user_id: string; payment_id: string }[];
    expect(rows).toHaveLength(1);
    const winner = rows[0].user_id;
    const loser = winner === a ? rb : ra;
    if (loser.status === "fulfilled") expect(loser.value.order.userId).not.toBe(winner);
    else expect(loser.reason).toBeInstanceOf(OrderError);
    expect(inner.getCharge(rows[0].payment_id)!.refundedCents).toBe(0);
  });
});

describe("ADVERSARIAL round 2: resumable cancelEvent payouts", () => {
  it("two admins (or a double-clicked Retry) running at once pay every customer exactly once", async () => {
    const inner = createFakeStripe("sk_test_adv_r2");
    const ev = await venue(t.db);
    const orders = [];
    for (let i = 0; i < 4; i++) orders.push(await book(inner, ev.id, await newUser(), 1 + i));
    let down = true;
    const p = flaky(inner, () => down);
    await expect(cancelEvent(deps(p), ev.id)).rejects.toBeInstanceOf(OrderError);
    down = false;
    await Promise.allSettled([cancelEvent(deps(p), ev.id), cancelEvent(deps(p), ev.id), cancelEvent(deps(p), ev.id)]);
    for (const o of orders) {
      expect(inner.getCharge(o.paymentId)!.refundedCents, `order ${o.id}`).toBe(o.ticketsCents);
      expect((await getOrder(t.db, o.id))!.refundId).not.toBeNull();
    }
    await expect(cancelEvent(deps(p), ev.id)).rejects.toThrow(/already cancelled/);
  });

  it("two concurrent first cancels pay once", async () => {
    const inner = createFakeStripe("sk_test_adv_r2");
    const ev = await venue(t.db);
    const o = await book(inner, ev.id, await newUser(), 3);
    await Promise.allSettled([cancelEvent(deps(inner), ev.id), cancelEvent(deps(inner), ev.id)]);
    expect(inner.getCharge(o.paymentId)!.refundedCents).toBe(o.ticketsCents);
  });

  it("one order whose payout keeps failing does not block the others, and is paid once it recovers", async () => {
    const inner = createFakeStripe("sk_test_adv_r2");
    const ev = await venue(t.db);
    const good = await book(inner, ev.id, await newUser());
    const bad = await book(inner, ev.id, await newUser(), 2);
    let badDown = true;
    const p = flaky(inner, (id) => badDown && id === bad.paymentId);
    await expect(cancelEvent(deps(p), ev.id)).rejects.toThrow(/1 of 2/);
    expect(inner.getCharge(good.paymentId)!.refundedCents).toBe(good.ticketsCents);
    expect(inner.getCharge(bad.paymentId)!.refundedCents).toBe(0);
    // The retry comes after the show date: money is still owed and must go out.
    badDown = false;
    await cancelEvent(deps(p, ev.startsAtMs + DAY), ev.id);
    expect(inner.getCharge(bad.paymentId)!.refundedCents).toBe(bad.ticketsCents);
    expect(inner.getCharge(good.paymentId)!.refundedCents).toBe(good.ticketsCents);
  });

  it("an order the customer refunded before the cancel is not topped up or retried", async () => {
    const inner = createFakeStripe("sk_test_adv_r2");
    const ev = await venue(t.db);
    const uid = await newUser();
    const self = await book(inner, ev.id, uid, 2);
    const r = await cancelOwnOrder(deps(inner), uid, self.id);
    const other = await book(inner, ev.id, await newUser());
    let down = true;
    const p = flaky(inner, () => down);
    await expect(cancelEvent(deps(p), ev.id)).rejects.toBeInstanceOf(OrderError);
    down = false;
    const done = await cancelEvent(deps(p), ev.id);
    expect(done.refundedOrders).toBe(1);
    expect(inner.getCharge(self.paymentId)!.refundedCents).toBe(r.refundCents);
    expect(inner.getCharge(other.paymentId)!.refundedCents).toBe(other.ticketsCents);
  });

  it("the retry path cannot cancel an event that was never cancelled after it started", async () => {
    const inner = createFakeStripe("sk_test_adv_r2");
    const ev = await venue(t.db);
    const o = await book(inner, ev.id, await newUser());
    await expect(cancelEvent(deps(inner, ev.startsAtMs), ev.id)).rejects.toThrow(/already started/);
    expect((await getOrder(t.db, o.id))!.status).toBe("paid");
  });
});

describe("ADVERSARIAL round 2: a customer's own refund (refund_order) that fails at the provider", () => {
  it("can be retried until the customer is paid", async () => {
    const inner = createFakeStripe("sk_test_adv_r2");
    const ev = await venue(t.db);
    const uid = await newUser();
    const o = await book(inner, ev.id, uid, 2);
    let down = true;
    const p = flaky(inner, () => down);
    await expect(cancelOwnOrder(deps(p), uid, o.id)).rejects.toThrow();
    down = false;
    // The customer / their agent tries again, the only way they can.
    await cancelOwnOrder(deps(p), uid, o.id).catch(() => undefined);
    const row = (await getOrder(t.db, o.id))!;
    expect(row.status).toBe("refunded");
    expect(inner.getCharge(o.paymentId)!.refundedCents, "marked refunded, money never sent").toBe(row.refundCents);
  });
});
