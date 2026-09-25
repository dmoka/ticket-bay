// Account-owned orders at the service layer, against a real Postgres
// (Testcontainers): cancelOwnOrder, cancelEvent, placeOrder replays across
// users, and the tools' own anonymous guard when no route stands in front of
// them. Users are real Better Auth accounts; payments are the fake Stripe.
import { describe, it, expect } from "vitest";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { getEvent } from "../../src/db/events-repo";
import { getOrder, listOrdersByUser } from "../../src/db/orders-repo";
import { orders } from "../../src/db/schema";
import { createFakeStripe, PaymentError, type PaymentProvider } from "../../src/payments";
import { createTicketBayServer, UNAUTHENTICATED_MESSAGE, type Caller } from "../../src/mcp/tools";
import { cancelEvent, cancelOwnOrder, OrderError, placeOrder, quoteOrder, type Deps } from "../../src/services/orders";
import { useTestDatabase } from "./database";
import { DAY, HOUR, NOW, venue } from "./fixtures";
import { BASE_URL, customer, makeAuth, readReply, toolCallRequest, toolResult, useCleanAccounts } from "./accounts";

const t = useTestDatabase();
useCleanAccounts(t);

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrderError);
    return (e as Error).message;
  }
  throw new Error("expected an OrderError");
}

let keys = 0;
function deps(nowMs = NOW): Deps {
  return { db: t.db, payments: createFakeStripe("sk_test_integration"), nowMs };
}
function bookAs(d: Deps, userId: string | undefined, eventId: string, quantity: number, idempotencyKey = `k-${++keys}`) {
  return placeOrder(d, { eventId, quantity, email: "fan@example.com", name: "A Fan", idempotencyKey, userId });
}

async function twoCustomers() {
  const auth = makeAuth(t.db);
  return { anna: await customer(auth, "Anna"), bela: await customer(auth, "Bela") };
}

describe("cancelOwnOrder", () => {
  it("refuses someone else's order as 'Order not found.' and leaves it paid", async () => {
    const { anna, bela } = await twoCustomers();
    const d = deps();
    const ev = await venue(t.db);
    const { order } = await bookAs(d, anna.id, ev.id, 2);
    expect(order.userId).toBe(anna.id);

    expect(await refused(cancelOwnOrder(d, bela.id, order.id))).toBe("Order not found.");
    const still = (await getOrder(t.db, order.id))!;
    expect(still.status).toBe("paid");
    expect(still.refundCents).toBeNull();
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(42);

    const r = await cancelOwnOrder(d, anna.id, order.id);
    expect(r.order.status).toBe("refunded");
    expect(r.refundCents).toBe(9800); // 2 × €50 less the 2% refund fee
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(40);
  });

  it("refuses an order with no owner (placed before accounts existed) for every user", async () => {
    const { anna } = await twoCustomers();
    const d = deps();
    const ev = await venue(t.db);
    const { order } = await bookAs(d, undefined, ev.id, 1);
    expect(order.userId).toBeNull();
    expect(await refused(cancelOwnOrder(d, anna.id, order.id))).toBe("Order not found.");
    expect((await getOrder(t.db, order.id))!.status).toBe("paid");
  });

  it("refuses non-integer and unknown ids without touching the database rows", async () => {
    const { anna } = await twoCustomers();
    const d = deps();
    for (const id of [Number.NaN, 1.5, -1, 0, 424242]) {
      expect(await refused(cancelOwnOrder(d, anna.id, id))).toBe("Order not found.");
    }
  });

  it("a second refund by the owner is refused and pays nothing twice", async () => {
    const { anna } = await twoCustomers();
    const d = deps();
    const ev = await venue(t.db);
    const { order } = await bookAs(d, anna.id, ev.id, 2);
    await cancelOwnOrder(d, anna.id, order.id);
    expect(await refused(cancelOwnOrder(d, anna.id, order.id))).toContain("already been refunded");
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(40);
  });
});

describe("placeOrder replays across users", () => {
  it("the owner's retry replays the same order; another user (or anonymous) reusing the key is refused", async () => {
    const { anna, bela } = await twoCustomers();
    const d = deps();
    const ev = await venue(t.db);
    const first = await bookAs(d, anna.id, ev.id, 2, "shared-key");
    expect(first.replayed).toBe(false);

    const again = await bookAs(d, anna.id, ev.id, 2, "shared-key");
    expect(again.replayed).toBe(true);
    expect(again.order.id).toBe(first.order.id);

    expect(await refused(bookAs(d, bela.id, ev.id, 2, "shared-key"))).toMatch(/already used/);
    expect(await refused(bookAs(d, undefined, ev.id, 2, "shared-key"))).toMatch(/already used/);

    expect(await listOrdersByUser(t.db, bela.id)).toEqual([]);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(42);
  });

  it("an anonymous order's key cannot be replayed by a signed-in user", async () => {
    const { anna } = await twoCustomers();
    const d = deps();
    const ev = await venue(t.db);
    await bookAs(d, undefined, ev.id, 1, "anon-key");
    expect(await refused(bookAs(d, anna.id, ev.id, 1, "anon-key"))).toMatch(/already used/);
  });
});

describe("cancelEvent", () => {
  it("refunds every paid order in full (tickets part, no fee), releases every seat and stops sales", async () => {
    const { anna, bela } = await twoCustomers();
    const payments = createFakeStripe("sk_test_integration");
    const d: Deps = { db: t.db, payments, nowMs: NOW };
    const ev = await venue(t.db);
    const other = await venue(t.db);

    const a = (await bookAs(d, anna.id, ev.id, 2)).order;
    const b = (await bookAs(d, bela.id, ev.id, 5)).order; // group tier
    const gone = (await bookAs(d, anna.id, ev.id, 1)).order;
    await cancelOwnOrder(d, anna.id, gone.id); // already refunded before the event is called off
    const untouched = (await bookAs(d, bela.id, other.id, 1)).order;
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(47);

    const r = await cancelEvent({ ...d, nowMs: NOW + HOUR }, ev.id);
    expect(r.refundedOrders).toBe(2);
    expect(r.refundedCents).toBe(a.ticketsCents + b.ticketsCents);
    expect(r.event.cancelledAtMs).toBe(NOW + HOUR);
    expect(r.event.seatsSold).toBe(40);

    for (const o of [a, b]) {
      const row = (await getOrder(t.db, o.id))!;
      expect(row.status).toBe("refunded");
      expect(row.refundCents).toBe(o.ticketsCents);
      expect(row.refundFeeCents).toBe(0);
      expect(row.seatsReleased).toBe(true);
      expect(row.refundedAtMs).toBe(NOW + HOUR);
      expect(row.refundId).not.toBeNull();
      const charge = await payments.getCharge(o.paymentId);
      expect(charge?.refundedCents).toBe(o.ticketsCents);
    }
    // The order refunded earlier keeps its own (fee-reduced) refund, not a second one.
    const g = (await getOrder(t.db, gone.id))!;
    expect(g.refundCents).toBe(4900);
    expect(g.refundedAtMs).toBe(NOW);
    // Other events are not touched.
    expect((await getOrder(t.db, untouched.id))!.status).toBe("paid");
    expect((await getEvent(t.db, other.id))!.cancelledAtMs).toBeNull();

    // Sales are closed: no quote, no booking, no second cancellation.
    expect(await refused(quoteOrder(d, ev.id, 1))).toBe("This event has been cancelled.");
    expect(await refused(bookAs({ ...d, nowMs: NOW + 2 * HOUR }, anna.id, ev.id, 1))).toBe("This event has been cancelled.");
    expect(await refused(cancelEvent(d, ev.id))).toBe("This event is already cancelled.");
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(40);
  });

  it("refunds in full inside the last day before the start (no refund window, no fee)", async () => {
    const { anna } = await twoCustomers();
    const d = deps();
    const ev = await venue(t.db); // starts at NOW + 10 days
    const { order } = await bookAs(d, anna.id, ev.id, 2);
    const lastMs = ev.startsAtMs - 1;
    const r = await cancelEvent({ ...d, nowMs: lastMs }, ev.id);
    expect(r.refundedOrders).toBe(1);
    expect(r.refundedCents).toBe(order.ticketsCents);
    const row = (await getOrder(t.db, order.id))!;
    expect(row).toMatchObject({ status: "refunded", refundCents: order.ticketsCents, refundFeeCents: 0, seatsReleased: true });
    expect(row.refundId).not.toBeNull();
    expect((await getEvent(t.db, ev.id))!).toMatchObject({ cancelledAtMs: lastMs, seatsSold: 40 });
  });

  it.each([
    ["exactly at the start", 0],
    ["one ms after the start", 1],
    ["a day after the start", DAY],
  ])("is refused %s and changes nothing", async (_label, afterStart) => {
    const { anna } = await twoCustomers();
    const payments = createFakeStripe("sk_test_integration");
    const d: Deps = { db: t.db, payments, nowMs: NOW };
    const ev = await venue(t.db);
    const { order } = await bookAs(d, anna.id, ev.id, 2);

    const msg = await refused(cancelEvent({ ...d, nowMs: ev.startsAtMs + afterStart }, ev.id));
    expect(msg).toMatch(/already started/);

    expect((await getEvent(t.db, ev.id))!).toMatchObject({ cancelledAtMs: null, seatsSold: 42 });
    const row = (await getOrder(t.db, order.id))!;
    expect(row).toMatchObject({ status: "paid", refundCents: null, refundedAtMs: null, refundId: null });
    expect(payments.getCharge(order.paymentId)!.refundedCents).toBe(0);
  });

  it("an event with no orders is cancelled with zero refunds; an unknown event is refused", async () => {
    const d = deps();
    const ev = await venue(t.db);
    const r = await cancelEvent(d, ev.id);
    expect(r).toMatchObject({ refundedOrders: 0, refundedCents: 0 });
    expect(r.event.cancelledAtMs).toBe(NOW);
    expect(await refused(cancelEvent(d, "no-such-event"))).toBe("Event not found.");
  });

  it("the owner cannot refund again after the event was cancelled", async () => {
    const { anna } = await twoCustomers();
    const d = deps();
    const ev = await venue(t.db);
    const { order } = await bookAs(d, anna.id, ev.id, 2);
    await cancelEvent(d, ev.id);
    expect(await refused(cancelOwnOrder(d, anna.id, order.id))).toContain("already been refunded");
    const [row] = await t.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row!.refundCents).toBe(order.ticketsCents);
  });

  it("a checkout that races the cancellation never leaves a paid order on a cancelled event", async () => {
    const { anna } = await twoCustomers();
    const d = deps();
    const ev = await venue(t.db);
    const booking = bookAs(d, anna.id, ev.id, 2).then(
      (r) => r,
      (e) => e,
    );
    const cancelled = await cancelEvent(d, ev.id);
    await booking;
    const paidLeft = (await listOrdersByUser(t.db, anna.id)).filter((o) => o.order.status === "paid");
    expect(paidLeft).toEqual([]);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(40);
    expect(cancelled.event.cancelledAtMs).toBe(NOW);
  });
});

/** A provider whose refunds fail for the given charges until `heal()` is called. */
function failingRefunds(inner: PaymentProvider = createFakeStripe("sk_test_integration")) {
  const broken = new Set<string>();
  const refundCalls: string[] = [];
  const provider: PaymentProvider = {
    charge: (input) => inner.charge(input),
    getCharge: (id) => inner.getCharge(id),
    async refund(chargeId, amountCents, key) {
      refundCalls.push(key);
      if (broken.has(chargeId)) throw new PaymentError("provider is down", "no_such_charge");
      return inner.refund(chargeId, amountCents, key);
    },
  };
  return { provider, inner, refundCalls, breakFor: (id: string) => broken.add(id), heal: () => broken.clear() };
}

describe("cancelEvent payouts are resumable", () => {
  it("a payout that fails mid-cancel is retried by cancelling again, and every customer is paid exactly once", async () => {
    const { anna, bela } = await twoCustomers();
    const p = failingRefunds();
    const d: Deps = { db: t.db, payments: p.provider, nowMs: NOW };
    const ev = await venue(t.db);
    const a = (await bookAs(d, anna.id, ev.id, 2)).order;
    const b = (await bookAs(d, bela.id, ev.id, 3)).order;
    const c = (await bookAs(d, anna.id, ev.id, 1)).order;
    p.breakFor(b.paymentId);

    const msg = await refused(cancelEvent({ ...d, nowMs: NOW + HOUR }, ev.id));
    expect(msg).toMatch(/1 of 3 refunds failed/);

    // The event is cancelled and every order is marked refunded; only b's money is still owed.
    expect((await getEvent(t.db, ev.id))!).toMatchObject({ cancelledAtMs: NOW + HOUR, seatsSold: 40 });
    for (const o of [a, b, c]) expect((await getOrder(t.db, o.id))!.status).toBe("refunded");
    expect((await getOrder(t.db, a.id))!.refundId).not.toBeNull();
    expect((await getOrder(t.db, c.id))!.refundId).not.toBeNull();
    expect((await getOrder(t.db, b.id))!.refundId).toBeNull();
    expect(p.inner.getCharge(b.paymentId)!.refundedCents).toBe(0);
    // Sales stay closed while a payout is owed.
    expect(await refused(bookAs({ ...d, nowMs: NOW + 2 * HOUR }, bela.id, ev.id, 1))).toBe("This event has been cancelled.");

    // Still broken: the retry fails again, nothing is paid twice.
    const callsBefore = p.refundCalls.length;
    expect(await refused(cancelEvent({ ...d, nowMs: NOW + 2 * HOUR }, ev.id))).toMatch(/1 of 1 refunds failed/);
    expect(p.refundCalls.slice(callsBefore)).toEqual([`event-cancel-${b.id}`]);

    // Provider back: the retry pays only b — even though the event has started by now.
    p.heal();
    const retryCalls = p.refundCalls.length;
    const r = await cancelEvent({ ...d, nowMs: ev.startsAtMs + DAY }, ev.id);
    expect(p.refundCalls.slice(retryCalls)).toEqual([`event-cancel-${b.id}`]);
    expect(r.refundedOrders).toBe(3);
    expect(r.refundedCents).toBe(a.ticketsCents + b.ticketsCents + c.ticketsCents);
    for (const o of [a, b, c]) {
      const row = (await getOrder(t.db, o.id))!;
      expect(row.refundId).not.toBeNull();
      expect(row.refundCents).toBe(o.ticketsCents);
      expect(row.refundedAtMs).toBe(NOW + HOUR);
      expect(p.inner.getCharge(o.paymentId)!.refundedCents).toBe(o.ticketsCents);
    }
    expect((await getEvent(t.db, ev.id))!).toMatchObject({ cancelledAtMs: NOW + HOUR, seatsSold: 40 });

    // Nothing owed any more: a further cancel is refused and pays nobody.
    const doneCalls = p.refundCalls.length;
    expect(await refused(cancelEvent(d, ev.id))).toBe("This event is already cancelled.");
    expect(p.refundCalls.length).toBe(doneCalls);
  });

  it("the retry does not pay a customer who had refunded their own order before the cancellation", async () => {
    const { anna, bela } = await twoCustomers();
    const p = failingRefunds();
    const d: Deps = { db: t.db, payments: p.provider, nowMs: NOW };
    const ev = await venue(t.db);
    const own = (await bookAs(d, anna.id, ev.id, 2)).order;
    await cancelOwnOrder(d, anna.id, own.id); // 2% fee kept, paid at NOW
    const b = (await bookAs(d, bela.id, ev.id, 2)).order;
    p.breakFor(b.paymentId);
    await refused(cancelEvent({ ...d, nowMs: NOW + HOUR }, ev.id));
    p.heal();
    const r = await cancelEvent({ ...d, nowMs: NOW + 2 * HOUR }, ev.id);
    expect(r.refundedOrders).toBe(1);
    expect(r.refundedCents).toBe(b.ticketsCents);
    expect(p.inner.getCharge(own.paymentId)!.refundedCents).toBe(own.ticketsCents - (await getOrder(t.db, own.id))!.refundFeeCents!);
    expect(p.inner.getCharge(b.paymentId)!.refundedCents).toBe(b.ticketsCents);
  });
});

/**
 * Like fixtures' chargesTogether, but never waits forever: charges are held
 * until `n` are in flight OR `ms` have passed. If the service lets two
 * same-key checkouts overlap, they leave the charge step together (the race);
 * if it serialises them, the first one is released by the timer instead of
 * deadlocking the test.
 */
function chargesTogetherOrAfter(n: number, ms: number, inner: PaymentProvider): PaymentProvider {
  let waiting = 0;
  let release!: () => void;
  const all = new Promise<void>((r) => (release = r));
  return {
    ...inner,
    async charge(input) {
      const charge = await inner.charge(input);
      if (++waiting >= n) release();
      const timer = setTimeout(release, ms);
      await all;
      clearTimeout(timer);
      return charge;
    },
    refund: (...args) => inner.refund(...args),
    getCharge: (id) => inner.getCharge(id),
  };
}

describe("placeOrder retries never give tickets away", () => {
  it("retrying with the same key after a failed (voided) attempt is refused and creates no order", async () => {
    const { anna, bela } = await twoCustomers();
    const inner = createFakeStripe("sk_test_integration");
    const ev = await venue(t.db); // 60 seats left
    let blocker: number | undefined;
    // While Anna's card is charged, Bela takes 55 seats: Anna's 10 no longer fit.
    const racing: PaymentProvider = {
      ...inner,
      refund: (...a) => inner.refund(...a),
      getCharge: (id) => inner.getCharge(id),
      async charge(input) {
        const ch = await inner.charge(input);
        if (input.idempotencyKey === "anna-checkout" && blocker === undefined) {
          blocker = (await bookAs({ db: t.db, payments: inner, nowMs: NOW }, bela.id, ev.id, 55, "bela-checkout")).order.id;
        }
        return ch;
      },
    };
    const d: Deps = { db: t.db, payments: racing, nowMs: NOW };

    expect(await refused(bookAs(d, anna.id, ev.id, 10, "anna-checkout"))).toMatch(/only 5 left/);

    // Seats come back, Anna "retries" with the SAME key.
    await cancelOwnOrder(d, bela.id, blocker!);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(40);
    const msg = await refused(bookAs(d, anna.id, ev.id, 10, "anna-checkout"));
    expect(msg).toMatch(/earlier attempt|new checkout/i);

    expect(await listOrdersByUser(t.db, anna.id)).toEqual([]);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(40);

    // A new key works and is charged for real.
    const fresh = await bookAs(d, anna.id, ev.id, 10, "anna-checkout-2");
    expect(inner.getCharge(fresh.order.paymentId)!.refundedCents).toBe(0);
  });

  it("two concurrent submits with the same key: one paid order, its charge NOT refunded, seats taken once", async () => {
    const { anna } = await twoCustomers();
    const inner = createFakeStripe("sk_test_integration");
    const d: Deps = { db: t.db, payments: chargesTogetherOrAfter(2, 300, inner), nowMs: NOW };
    const ev = await venue(t.db);

    const [x, y] = await Promise.all([bookAs(d, anna.id, ev.id, 2, "double-click"), bookAs(d, anna.id, ev.id, 2, "double-click")]);
    expect(x.order.id).toBe(y.order.id);
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);

    const mine = await listOrdersByUser(t.db, anna.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.order.status).toBe("paid");
    const charge = inner.getCharge(mine[0]!.order.paymentId)!;
    expect(charge.amountCents).toBe(mine[0]!.order.totalCents);
    expect(charge.refundedCents).toBe(0);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(42);
  });

  it("two concurrent submits with the same key from two users: the winner's charge is kept, the loser gets nothing", async () => {
    const { anna, bela } = await twoCustomers();
    const inner = createFakeStripe("sk_test_integration");
    const d: Deps = { db: t.db, payments: chargesTogetherOrAfter(2, 300, inner), nowMs: NOW };
    const ev = await venue(t.db);

    const results = await Promise.allSettled([bookAs(d, anna.id, ev.id, 2, "shared"), bookAs(d, bela.id, ev.id, 2, "shared")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0]!.reason).toBeInstanceOf(OrderError);

    const all = await t.db.select().from(orders);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("paid");
    expect(inner.getCharge(all[0]!.paymentId)!.refundedCents).toBe(0);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(42);
  });
});

describe("the tools' own guard (no route in front)", () => {
  const server = (caller: Caller) =>
    createMcpHandler(() =>
      createTicketBayServer({ db: t.db, payments: createFakeStripe("sk_test_integration"), now: () => NOW, baseURL: BASE_URL }, caller, {
        includePrivate: true,
      }),
    );

  it.each([
    ["book_tickets", { event_id: "x", quantity: 1 }],
    ["my_orders", {}],
    ["refund_order", { order_id: 1 }],
    ["cancel_event", { event_id: "x" }],
  ])("anonymous %s returns the 401-style tool error and writes nothing", async (tool, args) => {
    const ev = await venue(t.db);
    const a = { ...args, ...("event_id" in args ? { event_id: ev.id } : {}) };
    const r = toolResult(await readReply(await server(null).fetch(toolCallRequest(tool, a))));
    expect(r).toMatchObject({ isError: true, text: UNAUTHENTICATED_MESSAGE });
    expect(await t.db.select().from(orders)).toEqual([]);
    expect((await getEvent(t.db, ev.id))!).toMatchObject({ seatsSold: 40, cancelledAtMs: null });
  });

  it("the stdio server (includePrivate: false) does not expose private tools at all", async () => {
    const h = createMcpHandler(() =>
      createTicketBayServer({ db: t.db, payments: createFakeStripe("sk_test_integration"), now: () => NOW, baseURL: BASE_URL }, null, {
        includePrivate: false,
      }),
    );
    const reply = await readReply(await h.fetch(toolCallRequest("book_tickets", { event_id: "x", quantity: 1 })));
    const body = reply.body as { error?: unknown; result?: { isError?: boolean } };
    expect(body.error ?? body.result?.isError).toBeTruthy();
    expect(await t.db.select().from(orders)).toEqual([]);
  });
});
