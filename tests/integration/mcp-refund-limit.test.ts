// refund_order over real Streamable HTTP against a real Postgres: an agent may
// refund at most €100.00 by itself. Above that the tool moves no money and
// hands back a link to the order page, where the customer clicks Cancel order
// — the web path (cancelOwnOrder, what the page's server action calls) has no
// such limit.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it, expect } from "vitest";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { getEvent } from "../../src/db/events-repo";
import { getOrder } from "../../src/db/orders-repo";
import { user } from "../../src/db/schema";
import { createFakeStripe } from "../../src/payments";
import { createTicketBayServer, type Caller } from "../../src/mcp/tools";
import { cancelOwnOrder } from "../../src/services/orders";
import { useTestDatabase } from "./database";
import { DAY, NOW, venue } from "./fixtures";

const t = useTestDatabase();
const BASE = "http://localhost:3000";
// A fresh provider per test: the database restarts order ids between tests,
// and the fake keys refunds by order id.
let payments = createFakeStripe("sk_test_refund_limit");
let clock = NOW;
beforeEach(() => {
  payments = createFakeStripe("sk_test_refund_limit");
  clock = NOW;
});

const handler = createMcpHandler((ctx) => {
  const caller = (ctx.authInfo?.extra?.caller ?? null) as Caller;
  return createTicketBayServer({ db: t.db, payments, now: () => clock, baseURL: BASE }, caller, { includePrivate: true });
});

type Reply = { isError: boolean; data: any; text: string };

async function call(caller: NonNullable<Caller>, name: string, args: Record<string, unknown>): Promise<Reply> {
  const res = await handler.fetch(
    new Request(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    { authInfo: { token: "", clientId: "api-key", scopes: caller.scopes, extra: { caller } } },
  );
  const raw = await res.text();
  const dataLine = raw.split("\n").find((l) => l.startsWith("data: "));
  const body = JSON.parse(dataLine ? dataLine.slice(6) : raw);
  const text: string = body.result?.content?.[0]?.text ?? body.error?.message ?? raw;
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* a plain-text tool error */
  }
  return { isError: body.result?.isError === true || !!body.error, data, text };
}

async function newUser(): Promise<NonNullable<Caller>> {
  const id = `u_${randomUUID().slice(0, 12)}`;
  const email = `${id}@example.com`;
  await t.db.insert(user).values({ id, name: `User ${id}`, email, role: null });
  return { userId: id, email, name: `User ${id}`, role: null, scopes: ["tickets:read", "tickets:write"] };
}

/** Book `quantity` tickets at `priceCents` each, ten days before the show. */
async function booked(c: NonNullable<Caller>, priceCents: number, quantity = 1) {
  clock = NOW;
  const ev = await venue(t.db, { priceCents });
  const r = await call(c, "book_tickets", { event_id: ev.id, quantity });
  expect(r.isError, r.text).toBe(false);
  return { ev, orderId: r.data.order_id as number, paymentId: (await getOrder(t.db, r.data.order_id))!.paymentId };
}

describe("refund_order refunds at most €100.00 by itself", () => {
  it("a €100.00 refund (the exact limit) is made by the agent", async () => {
    const c = await newUser();
    // €102.04 for the ticket − 2% refund fee €2.04 = €100.00 back.
    const { orderId, paymentId } = await booked(c, 10_204);
    const r = await call(c, "refund_order", { order_id: orderId });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ refunded: true, refunded_eur: 100, status: "refunded" });
    expect(payments.getCharge(paymentId)!.refundedCents).toBe(10_000);
  });

  it("one cent over the limit: nothing moves, and the customer gets the order page link", async () => {
    const c = await newUser();
    // €102.05 − €2.04 fee = €100.01 back: one cent too much for an agent.
    const { ev, orderId, paymentId } = await booked(c, 10_205);
    const r = await call(c, "refund_order", { order_id: orderId });
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({
      refunded: false,
      order_id: orderId,
      status: "paid",
      refund_if_cancelled_now_eur: 100.01,
      agent_refund_limit_eur: 100,
    });
    expect(r.data.action_required).toMatch(/nothing has changed/i);
    expect(r.data.action_required).toMatch(/cancel order/i);
    expect(r.data).not.toHaveProperty("refunded_eur");

    const url = new URL(r.data.cancel_url);
    expect(url.origin).toBe(BASE);
    expect(url.pathname).toBe(`/orders/${orderId}`);
    expect(url.searchParams.get("via")).toBe("mcp");

    // The order is untouched: still paid, charge intact, seats still sold.
    const row = (await getOrder(t.db, orderId))!;
    expect(row).toMatchObject({ status: "paid", refundCents: null, refundId: null, refundedAtMs: null });
    expect(payments.getCharge(paymentId)!.refundedCents).toBe(0);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(ev.seatsSold + 1);

    // Asking again gives the same link, still without a refund.
    const again = await call(c, "refund_order", { order_id: `TB-${String(orderId).padStart(5, "0")}` });
    expect(again.data).toMatchObject({ refunded: false, cancel_url: r.data.cancel_url });
    expect(payments.getCharge(paymentId)!.refundedCents).toBe(0);
  });

  it("the link's page refunds the whole amount: the customer's own cancel has no limit", async () => {
    const c = await newUser();
    const { orderId, paymentId } = await booked(c, 50_000, 4); // €2,000.00 of tickets
    const handedBack = await call(c, "refund_order", { order_id: orderId });
    expect(handedBack.data.refunded).toBe(false);
    expect(payments.getCharge(paymentId)!.refundedCents).toBe(0);

    // What the Cancel order button on /orders/<id> runs:
    const r = await cancelOwnOrder({ db: t.db, payments, nowMs: clock }, c.userId, orderId);
    expect(r.refundCents).toBe(200_000 - 4_000);
    expect(payments.getCharge(paymentId)!.refundedCents).toBe(r.refundCents);
    expect((await getOrder(t.db, orderId))!.status).toBe("refunded");

    // And the agent's view agrees afterwards.
    const after = await call(c, "refund_order", { order_id: orderId });
    expect(after.isError).toBe(true);
    expect(after.text).toMatch(/already been refunded/i);
  });

  it("a big order whose window has closed refunds nothing, so the agent may still close it", async () => {
    const c = await newUser();
    const { ev, orderId, paymentId } = await booked(c, 50_000, 4);
    clock = ev.startsAtMs + DAY;
    const r = await call(c, "refund_order", { order_id: orderId });
    clock = NOW;
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ refunded: true, refunded_eur: 0, seats_released: false, status: "refunded" });
    expect(payments.getCharge(paymentId)!.refundedCents).toBe(0);
  });

  it("someone else's big order is still just 'not found' — no link, no amount", async () => {
    const alice = await newUser();
    const bob = await newUser();
    const { orderId } = await booked(alice, 50_000, 4);
    const r = await call(bob, "refund_order", { order_id: orderId });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Order not found.");
  });
});
