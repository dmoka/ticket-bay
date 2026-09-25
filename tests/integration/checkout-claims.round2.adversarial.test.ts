// ADVERSARIAL (catch-D mini-loop, round 2): owner tokens, holdClaim and the
// void-under-claim transaction. Hunting: a charge that ends neither booked nor
// voided after a takeover, and the refund call made inside a transaction.
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
async function until(cond: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}
const ageClaim = (key: string) => t.db.execute(sql`UPDATE checkout_claims SET claimed_at_ms = claimed_at_ms - ${SIX_MIN} WHERE idempotency_key = ${key}`);
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} did not finish within ${ms} ms`)), ms))]);
}

/** Every charge the provider holds: either an order stands on it, or it was refunded in full. */
async function assertNoOrphanCharges(inner: PaymentProvider, chargeIds: string[]) {
  const rows = (await t.db.execute(sql`SELECT payment_id, total_cents FROM orders`)).rows as { payment_id: string; total_cents: string }[];
  for (const id of new Set(chargeIds)) {
    const c = inner.getCharge(id)!;
    const order = rows.find((r) => r.payment_id === id);
    if (order) expect(c.amountCents - c.refundedCents, `order on ${id}`).toBe(Number(order.total_cents));
    else expect(c.refundedCents, `charge ${id} (€${c.amountCents / 100}) has no order and was not refunded`).toBe(c.amountCents);
  }
}

describe("ADVERSARIAL takeover: a charge must end booked or voided, never neither", () => {
  it.each([
    ["the newer attempt is refused before it charges (sold out at quote)", "sold-out"],
    ["the newer attempt's own charge call fails", "charge-fails"],
  ])("A charged and went stale; B took over; %s", async (_label, mode) => {
    const inner = createFakeStripe(`sk_test_orphan_${mode}`);
    const ev = await venue(t.db, { totalSeats: 10, seatsSold: 8 });
    const uid = await newUser();
    const key = `mcp:${uid}:orphan-${mode}`;
    const input = { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: key };
    const chargeIds: string[] = [];
    const releaseA = gate();
    let calls = 0;
    const p: PaymentProvider = {
      ...inner,
      async charge(i) {
        const n = ++calls;
        if (n === 2 && mode === "charge-fails") throw new Error("card network down");
        const c: Charge = { ...(await inner.charge(i)) };
        chargeIds.push(c.id);
        if (n === 1) await releaseA.p;
        return c;
      },
      refund: (...a) => inner.refund(...a),
      getCharge: (id) => inner.getCharge(id),
    };
    const a = placeOrder(deps(p), input).catch((e) => e);
    await until(() => chargeIds.length >= 1);
    await ageClaim(key); // A has been charging for > 5 min
    if (mode === "sold-out") await t.db.execute(sql`UPDATE events SET seats_sold = total_seats WHERE id = ${ev.id}`);
    const rb = await placeOrder(deps(p), input).catch((e) => e); // B takes over and fails
    expect(rb).toBeInstanceOf(Error);
    if (mode === "sold-out") await t.db.execute(sql`UPDATE events SET seats_sold = 8 WHERE id = ${ev.id}`);
    releaseA.open();
    const ra = await a;
    await assertNoOrphanCharges(inner, chargeIds);
    // and the customer can find out what happened: A's answer is readable
    if (ra instanceof Error) expect(ra).toBeInstanceOf(OrderError);
  });
});

describe("ADVERSARIAL the void runs the refund call inside a DB transaction", () => {
  it("10 failed bookings voiding against a slow processor leave the pool usable", async () => {
    const inner = createFakeStripe("sk_test_slow_void");
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let voiding = 0;
    const p: PaymentProvider = {
      ...inner,
      charge: (i) => inner.charge(i),
      async refund(id, c, k) {
        if (k.startsWith("void-")) {
          voiding++;
          await released;
        }
        return inner.refund(id, c, k);
      },
      getCharge: (id) => inner.getCharge(id),
    };
    // Sold out between quote and booking for everyone: every attempt voids.
    const ev = await venue(t.db, { totalSeats: 100, seatsSold: 0 });
    const size = (t.db.$client.options as { max?: number }).max ?? 10;
    // All attempts charge first (barrier, or 3 s), then the event sells out
    // before any of them books — so every attempt must void.
    let inFlight = 0;
    let openAll!: () => void;
    const all = new Promise<void>((r) => (openAll = r));
    let soldOut: Promise<unknown> | null = null;
    const racing: PaymentProvider = {
      ...p,
      async charge(i) {
        const c = await inner.charge(i);
        if (++inFlight >= size) openAll();
        await Promise.race([all, new Promise((r) => setTimeout(r, 3_000))]);
        soldOut ??= t.db.execute(sql`UPDATE events SET seats_sold = total_seats WHERE id = ${ev.id}`);
        await soldOut;
        return c;
      },
    };
    const attempts = [];
    for (let i = 0; i < size; i++) {
      const uid = await newUser();
      attempts.push(placeOrder(deps(racing), { eventId: ev.id, quantity: 1, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `sv-${i}-${uid}` }).catch((e) => e));
    }
    await until(() => voiding >= size, 8_000);
    try {
      await within(t.db.execute(sql`SELECT 1`), 2_000, `a plain query while ${voiding} voids wait on the processor`);
    } finally {
      release();
      await Promise.all(attempts);
    }
  }, 30_000);
});
