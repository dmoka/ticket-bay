// ADVERSARIAL (catch-D mini-loop, round 1): the checkout_claims design in
// placeOrder. One row claims an idempotency key; same-key attempts poll every
// 100 ms for up to 15 s holding no connection; a claim older than 5 min may be
// taken over; the claim is deleted in a finally. Real Postgres, fake Stripe.
// "Time passing" beyond 5 min is simulated by ageing the claim row.
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { user } from "../../src/db/schema";
import { createFakeStripe, type Charge, type PaymentProvider } from "../../src/payments";
import { OrderError, placeOrder, type Deps } from "../../src/services/orders";
import { useTestDatabase } from "./database";
import { NOW, venue } from "./fixtures";

const t = useTestDatabase();
const deps = (payments: PaymentProvider): Deps => ({ db: t.db, payments, nowMs: NOW });
const SIX_MIN = 6 * 60_000;

async function newUser(): Promise<string> {
  const id = `u_${randomUUID().slice(0, 12)}`;
  await t.db.insert(user).values({ id, name: "Fan", email: `${id}@example.com` });
  return id;
}
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
async function until(cond: () => boolean | Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await cond()) && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}
async function claimRow(key: string) {
  const r = await t.db.execute(sql`SELECT claimed_at_ms FROM checkout_claims WHERE idempotency_key = ${key}`);
  return r.rows[0] as { claimed_at_ms: string } | undefined;
}
async function ageClaim(key: string) {
  await t.db.execute(sql`UPDATE checkout_claims SET claimed_at_ms = claimed_at_ms - ${SIX_MIN} WHERE idempotency_key = ${key}`);
}
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} did not finish within ${ms} ms`)), ms))]);
}

/** Charges pause per call until released; responses are snapshots like a real provider's JSON. */
function pausable(inner = createFakeStripe("sk_test_claims")) {
  const releases: (() => void)[] = [];
  const charged: number[] = [];
  const p: PaymentProvider = {
    ...inner,
    async charge(i) {
      const c: Charge = { ...(await inner.charge(i)) };
      const g = gate();
      releases.push(g.open);
      charged.push(Date.now());
      await g.p;
      return c;
    },
    refund: (...a) => inner.refund(...a),
    getCharge: (id) => inner.getCharge(id),
  };
  return { p, inner, release: (n: number) => releases[n]!(), calls: () => charged.length };
}

describe("ADVERSARIAL checkout claims: stale takeover while the first attempt is still alive", () => {
  it("the first attempt's finally must not delete the claim of the attempt that took over", async () => {
    const ev = await venue(t.db);
    const uid = await newUser();
    const key = `mcp:${uid}:stale-own`;
    const input = { eventId: ev.id, quantity: 1, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: key };
    const s = pausable();
    const a = placeOrder(deps(s.p), input).catch((e) => e);
    await until(() => s.calls() >= 1);
    await ageClaim(key); // attempt A's charge has now been running for > 5 min
    const b = placeOrder(deps(s.p), input).catch((e) => e);
    await until(() => s.calls() >= 2);
    s.release(0); // A finishes (and runs its finally)
    await a;
    // B is still charging: its claim must still be there, or a third attempt walks in.
    const row = await claimRow(key);
    s.release(1);
    await b;
    expect(row, "B's claim was deleted by A's finally while B was still running").toBeDefined();
  });

  it("a takeover while a >5 min charge is still alive never yields a paid order on a voided charge", async () => {
    // A: charged, still in flight (slow processor). B takes the stale claim and
    // gets the SAME charge (snapshot, nothing refunded yet). A then loses its
    // seats, voids the charge; the seats free up; B books on the voided charge.
    const ev = await venue(t.db, { totalSeats: 10, seatsSold: 8 });
    const uid = await newUser();
    const key = `mcp:${uid}:stale-void`;
    const input = { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: key };
    const inner = createFakeStripe("sk_test_claims_void");
    const s = pausable(inner);
    const refundFreesSeats: PaymentProvider = {
      ...s.p,
      async refund(id, c, k) {
        const r = await inner.refund(id, c, k);
        if (k.startsWith("void-")) await t.db.execute(sql`UPDATE events SET seats_sold = 8 WHERE id = ${ev.id}`);
        return r;
      },
    };
    const a = placeOrder(deps(refundFreesSeats), input).catch((e) => e);
    await until(() => s.calls() >= 1);
    await ageClaim(key);
    const b = placeOrder(deps(refundFreesSeats), input).catch((e) => e);
    await until(() => s.calls() >= 2);
    await t.db.execute(sql`UPDATE events SET seats_sold = total_seats WHERE id = ${ev.id}`);
    s.release(0);
    await a;
    s.release(1);
    const rb = await b;
    const rows = (await t.db.execute(sql`SELECT payment_id, total_cents FROM orders`)).rows as { payment_id: string; total_cents: string }[];
    for (const o of rows) {
      const c = inner.getCharge(o.payment_id)!;
      expect(c.amountCents - c.refundedCents, `paid order on a charge with ${c.refundedCents} refunded (B: ${rb instanceof Error ? rb.message : "booked"})`).toBe(Number(o.total_cents));
    }
  });
});

describe("ADVERSARIAL checkout claims: leaks, ties, timeouts, storms", () => {
  it("no claim is left behind after success, a refusal before the charge, a failed charge, or a failure after the charge", async () => {
    const ev = await venue(t.db, { totalSeats: 10, seatsSold: 9 });
    const uid = await newUser();
    const ok = createFakeStripe("sk_test_leak");
    const base = { eventId: ev.id, email: `${uid}@example.com`, name: "F", userId: uid };
    await placeOrder(deps(ok), { ...base, quantity: 1, idempotencyKey: "leak-ok" });
    await placeOrder(deps(ok), { ...base, quantity: 1, email: "not-an-email", idempotencyKey: "leak-pre" }).catch(() => undefined);
    const boom: PaymentProvider = { ...ok, charge: async () => { throw new Error("card network down"); }, refund: ok.refund, getCharge: ok.getCharge };
    await placeOrder(deps(boom), { ...base, quantity: 1, idempotencyKey: "leak-charge" }).catch(() => undefined);
    await placeOrder(deps(ok), { ...base, quantity: 5, idempotencyKey: "leak-post" }).catch(() => undefined); // sold out after charge? (quote refuses)
    const r = await t.db.execute(sql`SELECT idempotency_key FROM checkout_claims WHERE idempotency_key LIKE 'leak-%'`);
    expect(r.rows).toEqual([]);
  });

  it("20 same-key submits at the same instant: one charge, one order, the rest replay or refuse readably", async () => {
    const ev = await venue(t.db);
    const uid = await newUser();
    const inner = createFakeStripe("sk_test_tie");
    let charges = 0;
    const counting: PaymentProvider = { ...inner, async charge(i) { charges++; return inner.charge(i); }, refund: inner.refund, getCharge: inner.getCharge };
    const input = { eventId: ev.id, quantity: 1, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `tie-${uid}` };
    const rs = await Promise.allSettled(Array.from({ length: 20 }, () => placeOrder(deps(counting), input)));
    const orders = (await t.db.execute(sql`SELECT id, payment_id FROM orders`)).rows as { id: number; payment_id: string }[];
    expect(orders).toHaveLength(1);
    expect(charges).toBe(1);
    expect(inner.getCharge(orders[0].payment_id)!.refundedCents).toBe(0);
    for (const r of rs) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(OrderError);
  });

  it("a waiter that times out gets a readable refusal, and retrying later with the same key returns the first attempt's order (no second charge)", async () => {
    const ev = await venue(t.db);
    const uid = await newUser();
    const s = pausable();
    const input = { eventId: ev.id, quantity: 1, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `slow-${uid}` };
    const a = placeOrder(deps(s.p), input);
    await until(() => s.calls() >= 1);
    const t0 = Date.now();
    const err = await placeOrder(deps(s.p), input).catch((e) => e);
    expect(err).toBeInstanceOf(OrderError);
    expect((err as Error).message).toMatch(/same idempotency key/);
    expect(Date.now() - t0).toBeLessThan(20_000);
    s.release(0);
    const first = await a;
    const again = await placeOrder(deps(s.p), input);
    expect(again.replayed).toBe(true);
    expect(again.order.id).toBe(first.order.id);
    expect(s.calls()).toBe(1);
  }, 40_000);

  it("a retry storm of 50 on one key while the first is stuck: other customers stay fast and the pool stays usable", async () => {
    const ev = await venue(t.db);
    const uid = await newUser();
    const other = await newUser();
    const s = pausable();
    const input = { eventId: ev.id, quantity: 1, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `storm-${uid}` };
    const first = placeOrder(deps(s.p), input).catch((e) => e);
    await until(() => s.calls() >= 1);
    const storm = Array.from({ length: 50 }, () => placeOrder(deps(s.p), input).catch((e) => e));
    await new Promise((r) => setTimeout(r, 500));
    try {
      const t0 = Date.now();
      await within(t.db.execute(sql`SELECT 1`), 1_000, "a plain query during the storm");
      await within(
        placeOrder(deps(createFakeStripe("sk_test_other")), { eventId: ev.id, quantity: 1, email: `${other}@example.com`, name: "O", userId: other, idempotencyKey: `other-${other}` }),
        2_000,
        "another customer's checkout during the storm",
      );
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      s.release(0);
      await first;
      await Promise.all(storm);
    }
    expect(s.calls()).toBe(1); // the 50 waiters replayed, none charged again
  }, 40_000);
});
