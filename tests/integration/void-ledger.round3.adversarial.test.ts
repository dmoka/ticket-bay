// ADVERSARIAL (catch-D mini-loop, round 3): the voided_charges ledger. After a
// failed booking the void is recorded under a per-key xact advisory lock, then
// the provider refund is called with no transaction open; "if that call fails,
// the next attempt with the key finishes it". Attacks: the refund fails and
// nobody retries (or retries differently), many same-key attempts at once,
// and lock-order deadlocks against cancelEvent.
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { user } from "../../src/db/schema";
import { createFakeStripe, type Charge, type PaymentProvider } from "../../src/payments";
import { cancelEvent, OrderError, placeOrder, type Deps } from "../../src/services/orders";
import { useTestDatabase } from "./database";
import { NOW, venue } from "./fixtures";

const t = useTestDatabase();
const deps = (payments: PaymentProvider): Deps => ({ db: t.db, payments, nowMs: NOW });

async function newUser(): Promise<string> {
  const id = `u_${randomUUID().slice(0, 12)}`;
  await t.db.insert(user).values({ id, name: "Fan", email: `${id}@example.com` });
  return id;
}

/** Fake Stripe whose void refunds fail while `down` is true; charges lose the seats (sold out after charge). */
function setup(evId: () => string) {
  const inner = createFakeStripe(`sk_test_ledger_${randomUUID().slice(0, 6)}`);
  const state = { down: false, failNext: 0, voidCalls: 0, chargeIds: [] as string[] };
  const p: PaymentProvider = {
    ...inner,
    async charge(i) {
      const c: Charge = { ...(await inner.charge(i)) };
      state.chargeIds.push(c.id);
      await t.db.execute(sql`UPDATE events SET seats_sold = total_seats WHERE id = ${evId()}`);
      return c;
    },
    async refund(id, c, k) {
      if (k.startsWith("void-")) {
        state.voidCalls++;
        if (state.down) throw new Error("processor timeout");
        if (state.failNext > 0) {
          state.failNext--;
          throw new Error("processor blip");
        }
      }
      return inner.refund(id, c, k);
    },
    getCharge: (id) => inner.getCharge(id),
  };
  return { p, inner, state };
}

describe("ADVERSARIAL void ledger: a failed void refund", () => {
  it("is finished by the next attempt with the same key, which books nothing (the documented path)", async () => {
    const ev = await venue(t.db, { totalSeats: 10, seatsSold: 8 });
    const uid = await newUser();
    const s = setup(() => ev.id);
    const input = { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `mcp:${uid}:v1` };
    s.state.down = true;
    await expect(placeOrder(deps(s.p), input)).rejects.toThrow();
    s.state.down = false;
    await t.db.execute(sql`UPDATE events SET seats_sold = 8 WHERE id = ${ev.id}`);
    await expect(placeOrder(deps(s.p), input)).rejects.toBeInstanceOf(OrderError);
    const c = s.inner.getCharge(s.state.chargeIds[0]!)!;
    expect(c.refundedCents).toBe(c.amountCents);
    expect((await t.db.execute(sql`SELECT count(*)::int AS n FROM orders`)).rows[0]).toEqual({ n: 0 });
  });

  it("is reported to the caller as a readable refusal, not a raw provider error", async () => {
    const ev = await venue(t.db, { totalSeats: 10, seatsSold: 8 });
    const uid = await newUser();
    const s = setup(() => ev.id);
    s.state.down = true;
    const err = await placeOrder(deps(s.p), { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `mcp:${uid}:v2` }).catch((e) => e);
    // The booking failed for a customer-facing reason (sold out); a provider
    // outage on the void must not turn that into an internal error.
    expect(err, String(err)).toBeInstanceOf(OrderError);
    // Human decision (catch K): keep the real reason and say the refund is pending.
    expect((err as Error).message).toMatch(/sold out|not enough seats/i);
    expect((err as Error).message).toMatch(/refund is pending.*same idempotency key/i);
  });

  it("a single transient void-refund failure is absorbed by the retry: money back, plain readable refusal", async () => {
    const ev = await venue(t.db, { totalSeats: 10, seatsSold: 8 });
    const uid = await newUser();
    const s = setup(() => ev.id);
    s.state.failNext = 1;
    const err = await placeOrder(deps(s.p), { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `mcp:${uid}:blip` }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderError);
    expect((err as Error).message).toMatch(/sold out|not enough seats/i);
    expect((err as Error).message).not.toMatch(/pending/i);
    expect(s.state.voidCalls).toBe(2);
    const c = s.inner.getCharge(s.state.chargeIds[0]!)!;
    expect(c.refundedCents).toBe(c.amountCents); // refunded exactly once, not twice
    expect((await t.db.execute(sql`SELECT count(*)::int AS n FROM orders`)).rows[0]).toEqual({ n: 0 });
  });

  it("two transient failures in a row are still absorbed (3 attempts), and never over-refund", async () => {
    const ev = await venue(t.db, { totalSeats: 10, seatsSold: 8 });
    const uid = await newUser();
    const s = setup(() => ev.id);
    s.state.failNext = 2;
    const err = await placeOrder(deps(s.p), { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `mcp:${uid}:blip2` }).catch((e) => e);
    expect(err).toBeInstanceOf(OrderError);
    expect((err as Error).message).not.toMatch(/pending/i);
    const c = s.inner.getCharge(s.state.chargeIds[0]!)!;
    expect(c.refundedCents).toBe(c.amountCents);
  });

  // ACCEPTED RISK (human decision 2026-09-25): a void refund that fails past 3 retries completes only on a same-key retry; no sweeper by design
  it.skip("still gets the money back when the agent retries with a NEW key (as every refusal message tells it to)", async () => {
    const ev = await venue(t.db, { totalSeats: 10, seatsSold: 8 });
    const uid = await newUser();
    const s = setup(() => ev.id);
    s.state.down = true;
    await placeOrder(deps(s.p), { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `mcp:${uid}:first` }).catch(() => undefined);
    s.state.down = false;
    await t.db.execute(sql`UPDATE events SET seats_sold = 8 WHERE id = ${ev.id}`);
    // "Start a new checkout (a new idempotency key)" — the agent does exactly that.
    await placeOrder(deps(s.p), { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `mcp:${uid}:second` }).catch(() => undefined);
    const first = s.inner.getCharge(s.state.chargeIds[0]!)!;
    expect(first.refundedCents, "the first attempt's voided charge was never paid back").toBe(first.amountCents);
  });

  // ACCEPTED RISK (human decision 2026-09-25): a void refund that fails past 3 retries completes only on a same-key retry; no sweeper by design
  it.skip("still gets the money back when the same key is retried with a different quantity", async () => {
    const ev = await venue(t.db, { totalSeats: 10, seatsSold: 8 });
    const uid = await newUser();
    const s = setup(() => ev.id);
    const key = `mcp:${uid}:qty`;
    s.state.down = true;
    await placeOrder(deps(s.p), { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: key }).catch(() => undefined);
    s.state.down = false;
    await t.db.execute(sql`UPDATE events SET seats_sold = 7 WHERE id = ${ev.id}`);
    await placeOrder(deps(s.p), { eventId: ev.id, quantity: 3, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: key }).catch(() => undefined);
    const first = s.inner.getCharge(s.state.chargeIds[0]!)!;
    expect(first.refundedCents, "voided charge never paid back").toBe(first.amountCents);
  });
});

describe("ADVERSARIAL void ledger under concurrency", () => {
  it("20 same-key attempts where the booking fails: one charge, voided exactly once, no order", async () => {
    const ev = await venue(t.db, { totalSeats: 10, seatsSold: 8 });
    const uid = await newUser();
    const s = setup(() => ev.id);
    const input = { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `mcp:${uid}:many` };
    const rs = await Promise.allSettled(Array.from({ length: 20 }, () => placeOrder(deps(s.p), input)));
    for (const r of rs) expect(r.status).toBe("rejected");
    for (const r of rs) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(OrderError);
    const ids = new Set(s.state.chargeIds);
    expect(ids.size).toBe(1);
    const c = s.inner.getCharge([...ids][0]!)!;
    expect(c.refundedCents).toBe(c.amountCents);
    expect((await t.db.execute(sql`SELECT count(*)::int AS n FROM orders`)).rows[0]).toEqual({ n: 0 });
  }, 30_000);

  it("checkouts (key lock → event lock) racing cancelEvent (event lock → orders) never deadlock into a raw error", async () => {
    const raw: string[] = [];
    for (let i = 0; i < 15; i++) {
      const ev = await venue(t.db);
      const payments = createFakeStripe(`sk_test_dl_${i}`);
      const buyers = await Promise.all(Array.from({ length: 5 }, () => newUser()));
      const rs = await Promise.allSettled([
        ...buyers.map((u, k) => placeOrder(deps(payments), { eventId: ev.id, quantity: 1, email: `${u}@example.com`, name: "F", userId: u, idempotencyKey: `dl-${i}-${k}` })),
        cancelEvent(deps(payments), ev.id),
      ]);
      for (const r of rs) if (r.status === "rejected" && !(r.reason instanceof OrderError)) raw.push(`#${i}: ${(r.reason as Error).message}`);
      // every order that exists was refunded by the cancel; every charge without an order was voided
      const orders = (await t.db.execute(sql`SELECT payment_id, status FROM orders WHERE event_id = ${ev.id}`)).rows as { payment_id: string; status: string }[];
      for (const o of orders) expect(o.status).toBe("refunded");
    }
    expect(raw, raw.join("\n")).toEqual([]);
  }, 60_000);
});
