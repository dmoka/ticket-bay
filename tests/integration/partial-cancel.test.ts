// Cancelling some of an order's tickets, through the order services against a
// real Postgres and the fake payment provider: one refund row per cancel,
// priced on running totals, seats back per cancel, the event cancellation on
// top of partial cancels, the database's own limits, and real races.
import { describe, it, expect } from "vitest";
import { cancelImpact } from "../../src/db/admin-queries";
import { closeDb, openDb } from "../../src/db/client";
import { getEvent } from "../../src/db/events-repo";
import { getOrder } from "../../src/db/orders-repo";
import { insertRefund, listRefundsForOrder } from "../../src/db/refunds-repo";
import { refunds } from "../../src/db/schema";
import { netRefund, refundFee } from "../../src/domain/refund";
import { createFakeStripe, type PaymentProvider } from "../../src/payments";
import { cancelEvent, cancelOrder, OrderError, quoteCancel, quoteOwnCancel, type Deps } from "../../src/services/orders";
import { eq } from "drizzle-orm";
import { useTestDatabase } from "./database";
import { DAY, getOrderRefunded, NOW, pgError, shop, venue } from "./fixtures";

const t = useTestDatabase();

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrderError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

const seatsSold = async (eventId: string) => (await getEvent(t.db, eventId))!.seatsSold;

describe("cancelling an order in parts", () => {
  it("one refund per cancel, seats back each time, refunded only when none are left — and the money adds up to a whole-order cancel", async () => {
    const s = shop(t.db);
    const ev = await venue(s.db); // 40 of 100 seats sold, €50.00
    const { order } = await s.book(ev.id, 4);
    expect(order.ticketsCents).toBe(20_000);
    expect(await seatsSold(ev.id)).toBe(44);

    const first = await s.cancel(order.id, 1);
    expect(first).toMatchObject({ tickets: 1, refundCents: 4_900, refundFeeCents: 100, seatsReleased: true });
    expect(first.order.status).toBe("paid");
    expect(await seatsSold(ev.id)).toBe(43);

    const second = await s.cancel(order.id, 2);
    // Running gross 15000, running fee 300: this cancel is 10000 gross, 200 fee.
    expect(second).toMatchObject({ tickets: 2, refundCents: 9_800, refundFeeCents: 200, seatsReleased: true });
    expect(second.order.status).toBe("paid");
    expect(await seatsSold(ev.id)).toBe(41);

    // No count: every ticket left.
    const last = await s.cancel(order.id);
    expect(last).toMatchObject({ tickets: 1, refundCents: 4_900, refundFeeCents: 100 });
    expect(last.order.status).toBe("refunded");
    expect(await seatsSold(ev.id)).toBe(40);

    expect(last.refunds.map((r) => [r.tickets, r.grossCents, r.feeCents, r.netCents, r.reason])).toEqual([
      [1, 5_000, 100, 4_900, "customer"],
      [2, 10_000, 200, 9_800, "customer"],
      [1, 5_000, 100, 4_900, "customer"],
    ]);
    for (const r of last.refunds) expect(r.providerRefundId).toMatch(/^re_/);
    const whole = netRefund({ totalCents: 20_000, tickets: 4, discountPercent: 0, eventStartMs: ev.startsAtMs }, 4, NOW);
    expect(s.payments.getCharge(order.paymentId)!.refundedCents).toBe(whole);

    expect(await refused(s.cancel(order.id, 1))).toBe("This order has already been refunded.");
    expect(await refused(s.cancel(order.id))).toBe("This order has already been refunded.");
    expect(s.payments.getCharge(order.paymentId)!.refundedCents).toBe(whole);
  });

  it("refuses zero, a fraction, or more tickets than are left — saying how many are left — and changes nothing", async () => {
    const s = shop(t.db);
    const ev = await venue(s.db);
    const { order } = await s.book(ev.id, 4);
    await s.cancel(order.id, 1);
    for (const n of [0, -1, 1.5, 4, 99, Number.NaN]) {
      expect(await refused(s.cancel(order.id, n)), String(n)).toBe("This order has 3 tickets left: cancel 1 to 3.");
    }
    await s.cancel(order.id, 2);
    expect(await refused(s.cancel(order.id, 2))).toBe("This order has 1 ticket left: cancel 1.");
    expect(await listRefundsForOrder(t.db, order.id)).toHaveLength(2);
    expect(await seatsSold(ev.id)).toBe(41);
  });

  it("from the event start on a partial cancel is refused — quote and cancel alike — and changes nothing", async () => {
    const s = shop(t.db);
    const ev = await venue(s.db, { startsAtMs: NOW + DAY });
    const { order } = await s.book(ev.id, 3);
    const lastMoment = await s.cancel(order.id, 1); // one ms before the start still goes through
    expect(lastMoment).toMatchObject({ tickets: 1, refundCents: 4_900, seatsReleased: true });

    s.setClock(NOW + DAY); // the instant the event starts
    const refusal = "The event has started: you can no longer cancel only some of the tickets. You can still cancel all 2 tickets left, with no refund.";
    expect(await refused(s.cancel(order.id, 1))).toBe(refusal);
    expect(await refused(quoteCancel({ db: t.db, nowMs: NOW + DAY }, order.id, 1))).toBe(refusal);
    expect(await listRefundsForOrder(t.db, order.id)).toHaveLength(1);
    expect((await getOrder(t.db, order.id))!.status).toBe("paid");
    expect(await seatsSold(ev.id)).toBe(42);
    expect(s.payments.getCharge(order.paymentId)!.refundedCents).toBe(4_900);
  });

  it("after the event started a full cancel works as before: nothing paid, seats kept, the order refunded", async () => {
    const s = shop(t.db);
    const ev = await venue(s.db, { startsAtMs: NOW + DAY });
    const untouched = (await s.book(ev.id, 3)).order;
    const partly = (await s.book(ev.id, 3)).order;
    await s.cancel(partly.id, 1);
    s.setClock(NOW + 2 * DAY);

    expect(await refused(s.cancel(untouched.id, 2))).toBe(
      "The event has started: you can no longer cancel only some of the tickets. You can still cancel the whole order, with no refund.",
    );
    // Every ticket left, by default or by count, is the full cancel.
    const whole = await s.cancel(untouched.id);
    expect(whole).toMatchObject({ tickets: 3, refundCents: 0, refundFeeCents: 0, seatsReleased: false });
    expect(whole.refund.providerRefundId).toBeNull();
    expect(whole.order.status).toBe("refunded");
    const rest = await s.cancel(partly.id, 2);
    expect(rest).toMatchObject({ tickets: 2, refundCents: 0, refundFeeCents: 0, seatsReleased: false });
    expect(rest.order.status).toBe("refunded");

    expect(await seatsSold(ev.id)).toBe(45); // only the ticket cancelled before the start went back on sale
    expect(s.payments.getCharge(untouched.paymentId)!.refundedCents).toBe(0);
    expect(s.payments.getCharge(partly.paymentId)!.refundedCents).toBe(4_900);
  });
});

describe("a cancel sent with an idempotency key", () => {
  it("sent twice returns the first result and cancels nothing more; the key is stored with the refund", async () => {
    const s = shop(t.db);
    const ev = await venue(s.db);
    const { order } = await s.book(ev.id, 4);

    const first = await s.cancel(order.id, 1, "key-a");
    expect(first).toMatchObject({ replayed: false, tickets: 1, refundCents: 4_900, refundFeeCents: 100 });
    expect(first.refund.idempotencyKey).toBe("cancel-key-a");
    const again = await s.cancel(order.id, 1, "key-a");
    expect(again).toMatchObject({ replayed: true, tickets: 1, refundCents: 4_900, refundFeeCents: 100, seatsReleased: true });
    expect(again.refund).toEqual(first.refund);

    expect(await listRefundsForOrder(t.db, order.id)).toHaveLength(1);
    expect(await seatsSold(ev.id)).toBe(43);
    expect(s.payments.getCharge(order.paymentId)!.refundedCents).toBe(4_900);

    // A new key is a new cancellation.
    const next = await s.cancel(order.id, 1, "key-b");
    expect(next).toMatchObject({ replayed: false, tickets: 1 });
    expect(await seatsSold(ev.id)).toBe(42);
  });

  it("still returns the first result when a new cancel would be refused: the order refunded, the event started", async () => {
    const s = shop(t.db);
    const ev = await venue(s.db, { startsAtMs: NOW + DAY });
    const { order } = await s.book(ev.id, 2);
    const part = await s.cancel(order.id, 1, "part");
    const rest = await s.cancel(order.id, undefined, "rest");
    expect(rest.order.status).toBe("refunded");

    s.setClock(NOW + 2 * DAY);
    expect(await s.cancel(order.id, 1, "part")).toMatchObject({ replayed: true, refund: part.refund, refundCents: 4_900 });
    // Sent without a count the first time, so the resend may name the count it got or leave it out again.
    expect(await s.cancel(order.id, undefined, "rest")).toMatchObject({ replayed: true, refund: rest.refund, tickets: 1 });
    expect(await s.cancel(order.id, 1, "rest")).toMatchObject({ replayed: true, refund: rest.refund });
    expect(await listRefundsForOrder(t.db, order.id)).toHaveLength(2);
    expect(s.payments.getCharge(order.paymentId)!.refundedCents).toBe(9_800);
  });

  it("is refused for a different cancellation — another count, another order — and changes nothing", async () => {
    const s = shop(t.db);
    const ev = await venue(s.db);
    const a = (await s.book(ev.id, 4)).order;
    const b = (await s.book(ev.id, 4)).order;
    await s.cancel(a.id, 1, "key");
    const refusal = "This idempotency key was already used for a different cancellation. Use a new key for a new cancellation.";
    expect(await refused(s.cancel(a.id, 2, "key"))).toBe(refusal);
    expect(await refused(s.cancel(b.id, 1, "key"))).toBe(refusal);
    expect(await listRefundsForOrder(t.db, a.id)).toHaveLength(1);
    expect(await listRefundsForOrder(t.db, b.id)).toEqual([]);
    expect(await seatsSold(ev.id)).toBe(47);
  });

  it("sent for two orders at the same moment cancels on one and is refused on the other", async () => {
    const s = shop(t.db);
    // Two events: cancels on one event queue on its row lock, these two really overlap.
    const one = await venue(s.db, { id: "one" });
    const two = await venue(s.db, { id: "two" });
    const a = (await s.book(one.id, 2)).order;
    const b = (await s.book(two.id, 2)).order;
    const results = await Promise.allSettled([s.cancel(a.id, 1, "both"), s.cancel(b.id, 1, "both")]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(OrderError);
    expect(lost.reason.message).toBe("This idempotency key was already used for a different cancellation. Use a new key for a new cancellation.");
    expect((await listRefundsForOrder(t.db, a.id)).length + (await listRefundsForOrder(t.db, b.id)).length).toBe(1);
    expect((await seatsSold(one.id)) + (await seatsSold(two.id))).toBe(83);
  });

  it("sent twice at the same moment cancels once", async () => {
    const s = shop(t.db);
    const ev = await venue(s.db);
    const { order } = await s.book(ev.id, 4);
    const both = await Promise.all([s.cancel(order.id, 1, "race"), s.cancel(order.id, 1, "race")]);
    expect(both.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(both[0].refund).toEqual(both[1].refund);
    expect(await listRefundsForOrder(t.db, order.id)).toHaveLength(1);
    expect(await seatsSold(ev.id)).toBe(43);
    expect(s.payments.getCharge(order.paymentId)!.refundedCents).toBe(4_900);
  });
});

describe("the cancel quote", () => {
  it("is exactly what the cancel then pays, step after step, and changes nothing by itself", async () => {
    const s = shop(t.db);
    const ev = await venue(s.db, { priceCents: 5_000 });
    const { order } = await s.book(ev.id, 3);
    const deps = (): Pick<Deps, "db" | "nowMs"> => ({ db: t.db, nowMs: NOW });
    for (const n of [1, 1, undefined]) {
      const q = await quoteCancel(deps(), order.id, n);
      const again = await quoteCancel(deps(), order.id, n);
      expect(again).toEqual(q);
      const r = await s.cancel(order.id, n);
      expect({ tickets: r.tickets, net: r.refundCents, fee: r.refundFeeCents, seats: r.seatsReleased, gross: r.refund.grossCents }).toEqual({
        tickets: q.tickets,
        net: q.netCents,
        fee: q.feeCents,
        seats: q.releasesSeats,
        gross: q.grossCents,
      });
    }
    expect(await refused(quoteCancel(deps(), order.id))).toBe("This order has already been refunded.");
  });

  it("defaults to every ticket left, reports how many are left, and refuses what the cancel would refuse", async () => {
    const s = shop(t.db);
    const ev = await venue(s.db);
    const { order } = await s.book(ev.id, 4);
    await s.cancel(order.id, 1);
    const q = await quoteCancel({ db: t.db, nowMs: NOW }, order.id);
    expect(q).toMatchObject({ tickets: 3, ticketsLeft: 3, windowOpen: true, grossCents: 15_000, feeCents: 300, netCents: 14_700 });
    expect(await refused(quoteCancel({ db: t.db, nowMs: NOW }, order.id, 4))).toBe("This order has 3 tickets left: cancel 1 to 3.");
    expect(await refused(quoteCancel({ db: t.db, nowMs: NOW }, 999_999))).toBe("Order not found.");
    expect(await listRefundsForOrder(t.db, order.id)).toHaveLength(1);
  });

  it("someone else's order is not found", async () => {
    const s = shop(t.db);
    const ev = await venue(s.db);
    const { order } = await s.book(ev.id, 2); // placed without an account
    expect(await refused(quoteOwnCancel({ db: t.db, nowMs: NOW }, "someone-else", order.id))).toBe("Order not found.");
  });
});

describe("the organiser cancels the event after partial cancels", () => {
  it("pays the tickets still held with no fee; earlier fees stay kept; the order's gross is exactly its tickets part", async () => {
    const s = shop(t.db);
    const ev = await venue(s.db);
    const { order } = await s.book(ev.id, 4);
    const untouched = (await s.book(ev.id, 2)).order;
    const partial = await s.cancel(order.id, 1); // 4900 back, 100 fee kept

    // What the admin is shown before confirming is what the cancellation pays.
    expect(await cancelImpact(t.db, ev.id)).toEqual({ orders: 2, tickets: 3 + 2, refundCents: 15_000 + 10_000 });

    const r = await cancelEvent({ db: t.db, payments: s.payments, nowMs: NOW }, ev.id);
    expect(r).toMatchObject({ refundedOrders: 2, refundedCents: 25_000 });

    const row = (await getOrderRefunded(t.db, order.id))!;
    expect(row.status).toBe("refunded");
    expect(row.refunds.map((x) => [x.reason, x.tickets, x.grossCents, x.feeCents, x.netCents])).toEqual([
      ["customer", 1, 5_000, 100, 4_900],
      ["event_cancelled", 3, 15_000, 0, 15_000],
    ]);
    expect(row.refunds.reduce((g, x) => g + x.grossCents, 0)).toBe(order.ticketsCents);
    expect(s.payments.getCharge(order.paymentId)!.refundedCents).toBe(order.ticketsCents - partial.refundFeeCents);
    expect(s.payments.getCharge(untouched.paymentId)!.refundedCents).toBe(untouched.ticketsCents);
    expect(await seatsSold(ev.id)).toBe(40);
  });

  it("leaves a fully cancelled order alone", async () => {
    const s = shop(t.db);
    const ev = await venue(s.db);
    const { order } = await s.book(ev.id, 2);
    await s.cancel(order.id, 2);
    const r = await cancelEvent({ db: t.db, payments: s.payments, nowMs: NOW }, ev.id);
    expect(r).toMatchObject({ refundedOrders: 0, refundedCents: 0 });
    expect(await listRefundsForOrder(t.db, order.id)).toHaveLength(1);
  });
});

describe("the database refuses refunds beyond the order", () => {
  const row = (orderId: number, over: Partial<typeof refunds.$inferInsert> = {}): typeof refunds.$inferInsert => ({
    orderId,
    tickets: 1,
    grossCents: 0,
    feeCents: 0,
    netCents: 0,
    reason: "customer",
    createdAtMs: NOW,
    seatsReleased: true,
    idempotencyKey: `raw-${Math.random()}`,
    ...over,
  });

  it("more tickets than the order has, over all its refunds", async () => {
    const s = shop(t.db);
    const { order } = await s.book((await venue(s.db)).id, 3);
    await insertRefund(t.db, row(order.id, { tickets: 2 }));
    expect((await pgError(insertRefund(t.db, row(order.id, { tickets: 2 })))).constraint).toBe("refunds_tickets_within_order");
    await insertRefund(t.db, row(order.id, { tickets: 1 }));
  });

  it("more gross than the tickets part, over all its refunds — on insert and on update", async () => {
    const s = shop(t.db);
    const { order } = await s.book((await venue(s.db)).id, 2); // tickets part 10000
    const first = await insertRefund(t.db, row(order.id, { grossCents: 6_000, feeCents: 120, netCents: 5_880 }));
    expect((await pgError(insertRefund(t.db, row(order.id, { grossCents: 4_001, netCents: 4_001 })))).constraint).toBe("refunds_within_tickets_paid");
    await insertRefund(t.db, row(order.id, { grossCents: 4_000, netCents: 4_000 }));
    expect(
      (await pgError(t.db.update(refunds).set({ grossCents: 6_001, netCents: 5_881 }).where(eq(refunds.id, first.id)))).constraint,
    ).toBe("refunds_within_tickets_paid");
  });

  it("a row whose amounts do not add up, a ticketless row, a reused payout key", async () => {
    const s = shop(t.db);
    const { order } = await s.book((await venue(s.db)).id, 2);
    expect((await pgError(insertRefund(t.db, row(order.id, { grossCents: 100, feeCents: 10, netCents: 80 })))).constraint).toBe("refunds_amounts_add_up");
    expect((await pgError(insertRefund(t.db, row(order.id, { grossCents: 100, feeCents: 200, netCents: -100 })))).constraint).toBe("refunds_amounts_add_up");
    expect((await pgError(insertRefund(t.db, row(order.id, { tickets: 0 })))).constraint).toBe("refunds_tickets_positive");
    await insertRefund(t.db, row(order.id, { idempotencyKey: "same" }));
    expect((await pgError(insertRefund(t.db, row(order.id, { idempotencyKey: "same" })))).constraint).toBe("refunds_idempotency_key_unique");
  });

  it("names the field when an amount is not a safe integer", async () => {
    const s = shop(t.db);
    const { order } = await s.book((await venue(s.db)).id, 2);
    await expect(insertRefund(t.db, row(order.id, { grossCents: 1.5 }))).rejects.toThrow("grossCents must be a safe integer");
  });
});

describe("races on one order", () => {
  it("concurrent partial cancels on two connections are priced one after another: exactly the tickets there are, exactly the whole-order money", async () => {
    const a = openDb(t.url);
    const b = openDb(t.url);
    try {
      const payments = createFakeStripe("sk_test_partial_race");
      const s = shop(t.db, payments);
      const ev = await venue(s.db, { priceCents: 5_000 });
      const { order } = await s.book(ev.id, 3);
      const on = (db: typeof a): Deps => ({ db, payments, nowMs: NOW });
      const rs = await Promise.allSettled([a, b, a, b].map((db) => cancelOrder(on(db), order.id, 1)));
      // The fourth finds no ticket left: it is refused, or — if the last
      // cancel's payout had not landed yet — it pays that payout (same key, so once).
      for (const r of rs) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(OrderError);
      const done = rs.flatMap((r) => (r.status === "fulfilled" ? [r.value.refund.id] : []));
      expect(new Set(done).size).toBe(3);

      const rows = await listRefundsForOrder(t.db, order.id);
      expect(rows).toHaveLength(3);
      expect(rows.reduce((n, r) => n + r.tickets, 0)).toBe(3);
      expect(rows.reduce((g, r) => g + r.grossCents, 0)).toBe(order.ticketsCents);
      const whole = netRefund({ totalCents: order.ticketsCents, tickets: 3, discountPercent: 0, eventStartMs: ev.startsAtMs }, 3, NOW);
      expect(payments.getCharge(order.paymentId)!.refundedCents).toBe(whole);
      expect(await seatsSold(ev.id)).toBe(40);
    } finally {
      await Promise.all([closeDb(a), closeDb(b)]);
    }
  });

  it("partial cancels racing the event cancellation: every ticket refunded once, the order's gross exactly its tickets part", async () => {
    for (let i = 0; i < 10; i++) {
      const payments = createFakeStripe("sk_test_partial_vs_event");
      const s = shop(t.db, payments);
      const ev = await venue(s.db);
      const { order } = await s.book(ev.id, 4);
      const deps: Deps = { db: t.db, payments, nowMs: NOW };
      await Promise.allSettled([cancelOrder(deps, order.id, 1), cancelEvent(deps, ev.id), cancelOrder(deps, order.id, 2)]);
      const row = (await getOrderRefunded(t.db, order.id))!;
      expect(row.status, `#${i}`).toBe("refunded");
      expect(row.ticketsCancelled).toBe(4);
      expect(row.refunds.reduce((g, r) => g + r.grossCents, 0)).toBe(order.ticketsCents);
      expect(payments.getCharge(order.paymentId)!.refundedCents).toBe(row.refundCents);
      expect(await seatsSold(ev.id)).toBe(40);
    }
  });
});

describe("a payout that fails", () => {
  /** A provider whose refunds fail while `down` is true. */
  function flaky(): PaymentProvider & { down: boolean } {
    const inner = createFakeStripe("sk_test_partial_flaky");
    const p = {
      down: false,
      charge: inner.charge,
      getCharge: inner.getCharge,
      async refund(id: string, cents: number, key: string) {
        if (p.down) throw new Error("processor timeout");
        return inner.refund(id, cents, key);
      },
    };
    return p;
  }

  it("is paid by the next cancel of the order, and never twice", async () => {
    const payments = flaky();
    const s = shop(t.db, payments);
    const ev = await venue(s.db);
    const { order } = await s.book(ev.id, 3);
    payments.down = true;
    await expect(s.cancel(order.id, 1)).rejects.toThrow("processor timeout");
    // Booked in our books, money owed: the refund row is there without a payout id.
    const owed = await listRefundsForOrder(t.db, order.id);
    expect(owed).toHaveLength(1);
    expect(owed[0].providerRefundId).toBeNull();
    expect(payments.getCharge(order.paymentId)!.refundedCents).toBe(0);

    payments.down = false;
    const next = await s.cancel(order.id, 1);
    expect(next.refunds.every((r) => r.providerRefundId !== null)).toBe(true);
    expect(payments.getCharge(order.paymentId)!.refundedCents).toBe(owed[0].netCents + next.refundCents);
  });

  it("on the last tickets: cancelling again pays it instead of refusing, and only once", async () => {
    const payments = flaky();
    const s = shop(t.db, payments);
    const ev = await venue(s.db);
    const { order } = await s.book(ev.id, 2);
    await s.cancel(order.id, 1);
    payments.down = true;
    await expect(s.cancel(order.id, 1)).rejects.toThrow("processor timeout");
    payments.down = false;
    const resumed = await s.cancel(order.id);
    expect(resumed).toMatchObject({ tickets: 1, refundCents: 4_900 });
    expect(payments.getCharge(order.paymentId)!.refundedCents).toBe(9_800);
    expect(await refused(s.cancel(order.id))).toBe("This order has already been refunded.");
    expect(payments.getCharge(order.paymentId)!.refundedCents).toBe(9_800);
  });

  it("is paid by a resend of the same idempotency key — once, without cancelling again", async () => {
    const payments = flaky();
    const s = shop(t.db, payments);
    const ev = await venue(s.db);
    const { order } = await s.book(ev.id, 4);
    payments.down = true;
    await expect(s.cancel(order.id, 1, "retry")).rejects.toThrow("processor timeout");
    expect(payments.getCharge(order.paymentId)!.refundedCents).toBe(0);

    payments.down = false;
    const again = await s.cancel(order.id, 1, "retry");
    expect(again).toMatchObject({ replayed: true, tickets: 1, refundCents: 4_900 });
    expect(again.refund.providerRefundId).toMatch(/^re_/);
    await s.cancel(order.id, 1, "retry");
    expect(await listRefundsForOrder(t.db, order.id)).toHaveLength(1);
    expect(await seatsSold(ev.id)).toBe(43);
    expect(payments.getCharge(order.paymentId)!.refundedCents).toBe(4_900);
  });
});
