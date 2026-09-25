// ADVERSARIAL (new loop, round 3): hammer catch F. cancelEvent locks
// event-then-orders, a customer's refund locks order-then-event, so Postgres
// breaks the deadlock by aborting one side; withDeadlockRetry must turn that
// into a clean re-run (or a readable OrderError) — never a raw driver error,
// never a double payout, never seats released twice.
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { getEvent } from "../../src/db/events-repo";
import { getOrder } from "../../src/db/orders-repo";
import { user } from "../../src/db/schema";
import { createFakeStripe, type PaymentProvider } from "../../src/payments";
import { cancelEvent, cancelOwnOrder, OrderError, placeOrder, type Deps } from "../../src/services/orders";
import { useTestDatabase } from "./database";
import { NOW, venue } from "./fixtures";

const t = useTestDatabase();
const deps = (payments: PaymentProvider): Deps => ({ db: t.db, payments, nowMs: NOW });

async function newUser(): Promise<string> {
  const id = `u_${randomUUID().slice(0, 12)}`;
  await t.db.insert(user).values({ id, name: "Fan", email: `${id}@example.com` });
  return id;
}

function describeRaw(e: unknown): string {
  const x = e as { message?: string; cause?: { message?: string; code?: string } };
  return `${x.cause?.code ?? ""} ${x.cause?.message ?? x.message ?? String(e)}`;
}

/** Every order: the provider paid out exactly what our books say, never above the tickets part. */
async function assertBooksMatchMoney(payments: PaymentProvider, ids: { id: number; paymentId: string; ticketsCents: number }[]) {
  for (const o of ids) {
    const row = (await getOrder(t.db, o.id))!;
    expect(row.status, `order ${o.id}`).toBe("refunded");
    const refunded = payments.getCharge(o.paymentId)!.refundedCents;
    expect(refunded, `order ${o.id} (${row.refundReason})`).toBe(row.refundCents);
    expect(refunded).toBeLessThanOrEqual(o.ticketsCents);
    if (row.refundReason === "event_cancelled") expect(refunded).toBe(o.ticketsCents);
  }
}

describe("ADVERSARIAL catch F hammered: cancelEvent vs customers' own refunds", () => {
  it("120 races, one customer each: no raw error escapes, money and seats exact", async () => {
    const raw: string[] = [];
    let deadlockish = 0;
    for (let i = 0; i < 120; i++) {
      const payments = createFakeStripe("sk_test_hammer");
      const uid = await newUser();
      const ev = await venue(t.db);
      const { order } = await placeOrder(deps(payments), { eventId: ev.id, quantity: 2, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `h1-${i}` });
      const rs = await Promise.allSettled([cancelEvent(deps(payments), ev.id), cancelOwnOrder(deps(payments), uid, order.id)]);
      for (const r of rs) {
        if (r.status === "rejected") {
          if (!(r.reason instanceof OrderError)) raw.push(`#${i}: ${describeRaw(r.reason)}`);
          else if (/same moment/.test(r.reason.message)) deadlockish++;
        }
      }
      // Whoever lost may retry; the event must end cancelled either way.
      if (rs[0].status === "rejected") await cancelEvent(deps(payments), ev.id).catch(() => undefined);
      await assertBooksMatchMoney(payments, [order]);
      expect((await getEvent(t.db, ev.id))!.seatsSold, `iteration ${i}`).toBe(ev.seatsSold);
    }
    expect(raw, raw.join("\n")).toEqual([]);
    // Informational: how often the retry budget ran out and a readable refusal was returned.
    expect(deadlockish).toBeLessThanOrEqual(120);
  }, 120_000);

  it("25 races with 4 customers each refunding while the admin cancels: every order paid exactly once, seats exact", async () => {
    const raw: string[] = [];
    for (let i = 0; i < 25; i++) {
      // Each real deadlock costs Postgres deadlock_timeout (1 s) to detect — hence the long timeout.
      const payments = createFakeStripe("sk_test_hammer4");
      const ev = await venue(t.db);
      const placed: { uid: string; id: number; paymentId: string; ticketsCents: number }[] = [];
      for (let k = 0; k < 4; k++) {
        const uid = await newUser();
        const { order } = await placeOrder(deps(payments), { eventId: ev.id, quantity: 1 + k, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `h4-${i}-${k}` });
        placed.push({ uid, id: order.id, paymentId: order.paymentId, ticketsCents: order.ticketsCents });
      }
      const rs = await Promise.allSettled([
        cancelEvent(deps(payments), ev.id),
        ...placed.map((p) => cancelOwnOrder(deps(payments), p.uid, p.id)),
        cancelEvent(deps(payments), ev.id), // a double-clicked confirm
      ]);
      for (const r of rs) if (r.status === "rejected" && !(r.reason instanceof OrderError)) raw.push(`#${i}: ${describeRaw(r.reason)}`);
      if ((await getEvent(t.db, ev.id))!.cancelledAtMs === null) await cancelEvent(deps(payments), ev.id).catch(() => undefined);
      await assertBooksMatchMoney(payments, placed);
      expect((await getEvent(t.db, ev.id))!.seatsSold, `iteration ${i}`).toBe(ev.seatsSold);
    }
    expect(raw, raw.join("\n")).toEqual([]);
  }, 240_000);

  it("races during a resumable payout (first cancel's payouts failed): a retry never pays anyone twice", async () => {
    const raw: string[] = [];
    for (let i = 0; i < 30; i++) {
      const inner = createFakeStripe("sk_test_hammer_resume");
      let down = true;
      const p: PaymentProvider = {
        ...inner,
        charge: inner.charge,
        async refund(id, c, k) {
          if (down && k.startsWith("event-cancel-")) throw new Error("processor timeout");
          return inner.refund(id, c, k);
        },
        getCharge: inner.getCharge,
      };
      const ev = await venue(t.db);
      const placed: { uid: string; id: number; paymentId: string; ticketsCents: number }[] = [];
      for (let k = 0; k < 3; k++) {
        const uid = await newUser();
        const { order } = await placeOrder(deps(p), { eventId: ev.id, quantity: 1, email: `${uid}@example.com`, name: "F", userId: uid, idempotencyKey: `hr-${i}-${k}` });
        placed.push({ uid, id: order.id, paymentId: order.paymentId, ticketsCents: order.ticketsCents });
      }
      await cancelEvent(deps(p), ev.id).catch(() => undefined); // books refunded, payouts owed
      down = false;
      const rs = await Promise.allSettled([
        cancelEvent(deps(p), ev.id),
        cancelEvent(deps(p), ev.id),
        ...placed.map((x) => cancelOwnOrder(deps(p), x.uid, x.id)), // customers try refund_order on owed orders
      ]);
      for (const r of rs) if (r.status === "rejected" && !(r.reason instanceof OrderError)) raw.push(`#${i}: ${describeRaw(r.reason)}`);
      await cancelEvent(deps(p), ev.id).catch(() => undefined);
      for (const x of placed) expect(inner.getCharge(x.paymentId)!.refundedCents, `order ${x.id}`).toBe(x.ticketsCents);
      expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(ev.seatsSold);
    }
    expect(raw, raw.join("\n")).toEqual([]);
  }, 120_000);
});
