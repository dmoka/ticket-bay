// ADVERSARIAL round 3: the advisory lock placeOrder now holds per idempotency
// key (withCheckoutLock) and the resumable customer refund in cancelOrder.
// The lock is taken on a pooled connection that is held for the whole
// checkout — including the external payment call.
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { getOrder } from "../../src/db/orders-repo";
import { user } from "../../src/db/schema";
import { createFakeStripe, type PaymentProvider } from "../../src/payments";
import { cancelEvent, cancelOwnOrder, OrderError, placeOrder, type Deps } from "../../src/services/orders";
import { useTestDatabase } from "./database";
import { NOW, venue } from "./fixtures";

const t = useTestDatabase();
const deps = (payments: PaymentProvider, nowMs = NOW): Deps => ({ db: t.db, payments, nowMs });

async function newUser(): Promise<string> {
  const id = `u_${randomUUID().slice(0, 12)}`;
  await t.db.insert(user).values({ id, name: "Fan", email: `${id}@example.com` });
  return id;
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} did not finish within ${ms} ms`)), ms))]);
}

/** A provider whose charges hang until released (a slow or stuck processor). */
function slowProvider() {
  const inner = createFakeStripe("sk_test_adv_r3");
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let inFlight = 0;
  const p: PaymentProvider = {
    ...inner,
    async charge(i) {
      const c = await inner.charge(i);
      inFlight++;
      await released;
      return c;
    },
    refund: (...a) => inner.refund(...a),
    getCharge: (id) => inner.getCharge(id),
  };
  return { p, inner, release, inFlight: () => inFlight };
}

async function until(cond: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

describe("ADVERSARIAL round 3: a slow payment provider must not take the database down with it", () => {
  it("10 checkouts waiting on the processor leave the pool usable for everyone else", async () => {
    const ev = await venue(t.db);
    const slow = slowProvider();
    const pool = t.db.$client;
    const size = (pool.options as { max?: number }).max ?? 10;
    const checkouts = [];
    for (let i = 0; i < size; i++) {
      const uid = await newUser();
      checkouts.push(
        placeOrder(deps(slow.p), { eventId: ev.id, quantity: 1, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `slow-${i}` }).catch((e) => e),
      );
    }
    await until(() => slow.inFlight() >= size);
    try {
      // Any other page, admin view or refund needs one connection.
      await within(t.db.execute(sql`SELECT 1`), 2_000, "a plain query while checkouts wait on the processor");
    } finally {
      slow.release();
      await Promise.all(checkouts);
    }
  });

  it("an agent's retry storm on ONE key while the first attempt is stuck does not starve other customers", async () => {
    const ev = await venue(t.db);
    const slow = slowProvider();
    const uid = await newUser();
    const other = await newUser(); // created up front: during the storm even this INSERT would hang
    const input = { eventId: ev.id, quantity: 1, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `mcp:${uid}:storm` };
    const attempts = [placeOrder(deps(slow.p), input).catch((e) => e)];
    await until(() => slow.inFlight() >= 1);
    for (let i = 0; i < 12; i++) attempts.push(placeOrder(deps(slow.p), input).catch((e) => e));
    await new Promise((r) => setTimeout(r, 200));
    const fast = createFakeStripe("sk_test_adv_r3_fast");
    try {
      await within(
        placeOrder(deps(fast), { eventId: ev.id, quantity: 1, email: `${other}@example.com`, name: "O", userId: other, idempotencyKey: `other-${other}` }),
        2_000,
        "another customer's checkout during a retry storm",
      );
    } finally {
      slow.release();
      await Promise.all(attempts);
    }
  });
});

describe("ADVERSARIAL round 3: the advisory lock is released and scoped per key", () => {
  it("a failed checkout does not leave its key locked (the retry with a new connection proceeds at once)", async () => {
    const ev = await venue(t.db, { totalSeats: 10, seatsSold: 10 });
    const uid = await newUser();
    const payments = createFakeStripe("sk_test_adv_r3");
    const input = { eventId: ev.id, quantity: 1, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: "fail-then-retry" };
    await expect(placeOrder(deps(payments), input)).rejects.toBeInstanceOf(OrderError);
    // bad input that throws before any query, and a bug-style throw
    await expect(placeOrder(deps(payments), { ...input, email: "nope" })).rejects.toBeInstanceOf(OrderError);
    const broken: PaymentProvider = { ...payments, charge: async () => { throw new Error("boom"); }, refund: payments.refund, getCharge: payments.getCharge };
    await t.db.execute(sql`UPDATE events SET seats_sold = 0 WHERE id = ${ev.id}`);
    await expect(placeOrder(deps(broken), { ...input, idempotencyKey: "boom-key" })).rejects.toThrow("boom");
    // Hold every pooled connection busy-but-free so the retries likely land on other connections.
    const held = await Promise.all([t.db.$client.connect(), t.db.$client.connect()]);
    held.forEach((c) => c.release());
    await within(placeOrder(deps(payments), { ...input, idempotencyKey: "boom-key" }), 2_000, "retry after a thrown charge");
    // Only this file's database: other test files run in parallel and hold their own short advisory locks.
    const locks = await t.db.execute(
      sql`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND a.datname = current_database()`,
    );
    expect((locks.rows[0] as { n: number }).n).toBe(0);
  });

  it("different keys never wait for each other", async () => {
    const ev = await venue(t.db);
    const slow = slowProvider();
    const a = await newUser();
    const stuck = placeOrder(deps(slow.p), { eventId: ev.id, quantity: 1, email: `${a}@example.com`, name: "A", userId: a, idempotencyKey: "key-A" }).catch((e) => e);
    await until(() => slow.inFlight() >= 1);
    const b = await newUser();
    try {
      await within(
        placeOrder(deps(createFakeStripe("sk_test_b")), { eventId: ev.id, quantity: 1, email: `${b}@example.com`, name: "B", userId: b, idempotencyKey: "key-B" }),
        2_000,
        "a checkout with a different key",
      );
    } finally {
      slow.release();
      await stuck;
    }
  });
});

describe("ADVERSARIAL round 3: the customer refund resume path", () => {
  it("cannot pay an event-cancelled order a second time (under the customer's refund key)", async () => {
    const inner = createFakeStripe("sk_test_adv_r3");
    const ev = await venue(t.db);
    const uid = await newUser();
    const { order } = await placeOrder(deps(inner), { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `c-${uid}` });
    let down = true;
    const flaky: PaymentProvider = {
      ...inner,
      async refund(id, c, k) {
        if (down) throw new Error("processor timeout");
        return inner.refund(id, c, k);
      },
      charge: inner.charge,
      getCharge: inner.getCharge,
    };
    await expect(cancelEvent(deps(flaky), ev.id)).rejects.toBeInstanceOf(OrderError);
    down = false;
    // The customer (or their agent) tries refund_order on the unpaid order...
    await cancelOwnOrder(deps(flaky), uid, order.id).catch(() => undefined);
    // ...and the admin presses Retry refunds.
    await cancelEvent(deps(flaky), ev.id).catch(() => undefined);
    expect(inner.getCharge(order.paymentId)!.refundedCents).toBe(order.ticketsCents);
  });

  it("concurrent resumes of one failed customer refund pay it exactly once", async () => {
    const inner = createFakeStripe("sk_test_adv_r3");
    const ev = await venue(t.db);
    const uid = await newUser();
    const { order } = await placeOrder(deps(inner), { eventId: ev.id, quantity: 3, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `r-${uid}` });
    let down = true;
    const flaky: PaymentProvider = {
      ...inner,
      async refund(id, c, k) {
        if (down) throw new Error("processor timeout");
        return inner.refund(id, c, k);
      },
      charge: inner.charge,
      getCharge: inner.getCharge,
    };
    await expect(cancelOwnOrder(deps(flaky), uid, order.id)).rejects.toThrow();
    down = false;
    await Promise.allSettled([1, 2, 3, 4].map(() => cancelOwnOrder(deps(flaky), uid, order.id)));
    const row = (await getOrder(t.db, order.id))!;
    expect(inner.getCharge(order.paymentId)!.refundedCents).toBe(row.refundCents);
    // a resumed refund must not release seats a second time
    const ev2 = await t.db.execute(sql`SELECT seats_sold FROM events WHERE id = ${ev.id}`);
    expect(Number((ev2.rows[0] as { seats_sold: number }).seats_sold)).toBe(ev.seatsSold);
    // and once paid, a further call is a plain refusal
    await expect(cancelOwnOrder(deps(inner), uid, order.id)).rejects.toThrow(/already been refunded/);
  });
});
