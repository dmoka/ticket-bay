// Partial refunds for AI agents and the web form: quote_refund and
// refund_order through the MCP route's POST (real Request, real API keys, real
// Postgres), and the order page's server actions (the cancel form and its live
// preview) with a signed-in browser's cookie. Same wiring as
// mcp-key-scopes.test.ts; the database is never mocked.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { createFakeStripe } from "../../src/payments";
import type { Auth } from "../../src/auth/auth";
import type { Db } from "../../src/db/client";
import { getEvent } from "../../src/db/events-repo";
import { listRefundsForOrder } from "../../src/db/refunds-repo";
import { events } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { useTestDatabase } from "./database";
import { DAY, venue } from "./fixtures";
import { bearer, customer, makeAuth, readReply, scopedKey, toolCallRequest, toolResult, useCleanAccounts, type Customer } from "./accounts";

const wiring = vi.hoisted(() => ({ auth: undefined as any, db: undefined as unknown, payments: undefined as unknown, cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(wiring.cookie ? { cookie: wiring.cookie } : {}) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth", () => ({
  appBaseURL: () => "http://localhost:3000",
  getAuth: () => wiring.auth,
  getSession: () => wiring.auth.api.getSession({ headers: new Headers(wiring.cookie ? { cookie: wiring.cookie } : {}) }),
}));
vi.mock("@/src/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/db/client")>()),
  getDb: () => wiring.db,
}));
vi.mock("@/src/payments", async () => ({ ...(await import("../../src/payments")), getPayments: () => wiring.payments }));
vi.mock("@/src/mcp/caller", () => import("../../src/mcp/caller"));
vi.mock("@/src/mcp/tools", () => import("../../src/mcp/tools"));
vi.mock("@/src/auth/auth", () => import("../../src/auth/auth"));
vi.mock("@/src/services/orders", () => import("../../src/services/orders"));

const t = useTestDatabase();
useCleanAccounts(t);

let auth: Auth;
let POST: (r: Request) => Promise<Response>;
let orderActions: typeof import("../../app/(public)/orders/[id]/actions");

beforeAll(async () => {
  auth = makeAuth(t.db);
  wiring.auth = auth;
  wiring.db = t.db;
  wiring.payments = createFakeStripe("sk_test_partial_mcp");
  ({ POST } = await import("../../app/api/mcp/route"));
  orderActions = await import("../../app/(public)/orders/[id]/actions");
});

const call = async (name: string, args: object = {}, headers: Record<string, string> = {}) => toolResult(await readReply(await POST(toolCallRequest(name, args, headers))));

/** 10 days out (no early-bird): 100 seats, 40 sold, €50.00. The MCP route runs on the wall clock. */
const upcoming = (db: Db, over: Parameters<typeof venue>[1] = {}) =>
  venue(db, { startsAtMs: Date.now() + 10 * DAY, createdAtMs: Date.now() - 30 * DAY, ...over });

/** The route runs on the wall clock, so "after the start" is an event whose start has moved into the past. */
const startedAnHourAgo = (eventId: string) =>
  t.db.update(events).set({ startsAtMs: Date.now() - 3_600_000 }).where(eq(events.id, eventId));

async function bookWith(c: Customer, eventId: string, quantity: number) {
  const r = await call("book_tickets", { event_id: eventId, quantity }, bearer(c.key));
  expect(r.isError, r.text).toBe(false);
  return r.data as { order_id: number; order_number: string };
}

describe("refund_order", () => {
  it("without tickets is refused with a message saying what to send — and nothing changes", async () => {
    const anna = await customer(auth, "Anna");
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna, ev.id, 2);
    const r = await call("refund_order", { order_id: booked.order_id }, bearer(anna.key));
    expect(r.isError).toBe(true);
    expect(r.text).toContain("tickets is required: send how many of the order's tickets to cancel");
    expect(r.text).toContain('{"order_id": "TB-00144", "tickets": 2, "idempotency_key": "<a new unique string>"}');
    expect(r.text).toContain("quote_refund");
    expect(await listRefundsForOrder(t.db, booked.order_id)).toEqual([]);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(42);
  });

  it("with a bad ticket count is refused, saying so", async () => {
    const anna = await customer(auth, "Anna");
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna, ev.id, 2);
    for (const tickets of [0, 1.5, "1"]) {
      const r = await call("refund_order", { order_id: booked.order_id, tickets, idempotency_key: crypto.randomUUID() }, bearer(anna.key));
      expect(r.isError, String(tickets)).toBe(true);
      expect(r.text).toContain("tickets must be a whole number of tickets, at least 1.");
    }
    const tooMany = await call("refund_order", { order_id: booked.order_id, tickets: 3, idempotency_key: crypto.randomUUID() }, bearer(anna.key));
    expect(tooMany).toMatchObject({ isError: true, text: "This order has 2 tickets left: cancel 1 to 2." });
  });

  it("cancels part of an order: this refund, the order's totals, every refund, and what the rest would bring", async () => {
    const anna = await customer(auth, "Anna");
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna, ev.id, 4); // €200.00 of tickets

    const first = await call("refund_order", { order_id: booked.order_number, tickets: 1, idempotency_key: crypto.randomUUID() }, bearer(anna.key));
    expect(first.isError, first.text).toBe(false);
    expect(first.data).toMatchObject({
      refunded: true,
      this_refund: { tickets: 1, refunded_eur: 49, refund_fee_kept_eur: 1, seats_released: true },
      seats_released: true,
      status: "paid",
      tickets_cancelled: 1,
      refunded_eur: 49,
      refund_fee_kept_eur: 1,
      tickets_left: 3,
      refund_if_cancelled_now_eur: 147,
    });

    const second = await call("refund_order", { order_id: booked.order_id, tickets: 3, idempotency_key: crypto.randomUUID() }, bearer(anna.key));
    expect(second.data).toMatchObject({
      this_refund: { tickets: 3, refunded_eur: 147, refund_fee_kept_eur: 3 },
      status: "refunded",
      tickets_cancelled: 4,
      refunded_eur: 196,
      refund_fee_kept_eur: 4,
    });
    expect(second.data.refunds).toHaveLength(2);
    expect(second.data).not.toHaveProperty("refund_if_cancelled_now_eur");
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(40);

    const list = await call("my_orders", {}, bearer(anna.key));
    expect(list.data.orders[0]).toMatchObject({ order_id: booked.order_id, status: "refunded", tickets_cancelled: 4, refunded_eur: 196 });
  });

  it("without an idempotency key — missing, empty, too long — is refused saying what to send, and nothing changes", async () => {
    const anna = await customer(auth, "Anna");
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna, ev.id, 2);
    for (const extra of [{}, { idempotency_key: "" }, { idempotency_key: "   " }]) {
      const r = await call("refund_order", { order_id: booked.order_id, tickets: 1, ...extra }, bearer(anna.key));
      expect(r.isError, JSON.stringify(extra)).toBe(true);
      expect(r.text).toContain("idempotency_key is required: any unique string for this cancellation");
      expect(r.text).toContain("Reuse it only to retry the same cancellation");
    }
    const long = await call("refund_order", { order_id: booked.order_id, tickets: 1, idempotency_key: "k".repeat(101) }, bearer(anna.key));
    expect(long.isError).toBe(true);
    expect(long.text).toContain("idempotency_key must be a string of 1-100 characters.");
    expect(await listRefundsForOrder(t.db, booked.order_id)).toEqual([]);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(42);
  });

  it("sent twice with the same idempotency key returns the first refund and cancels nothing more", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna, ev.id, 4);
    const other = await bookWith(bela, ev.id, 4);

    const first = await call("refund_order", { order_id: booked.order_id, tickets: 1, idempotency_key: "lost-reply" }, bearer(anna.key));
    expect(first.data).toMatchObject({ refunded: true, replayed: false, tickets_cancelled: 1 });
    const again = await call("refund_order", { order_id: booked.order_number, tickets: 1, idempotency_key: "lost-reply" }, bearer(anna.key));
    expect(again.isError, again.text).toBe(false);
    expect(again.data).toMatchObject({ refunded: true, replayed: true, this_refund: first.data.this_refund, tickets_cancelled: 1, refunded_eur: 49, tickets_left: 3 });
    expect(await listRefundsForOrder(t.db, booked.order_id)).toHaveLength(1);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(47);

    // The key belongs to that one cancellation: another count is refused, and another customer's same key is their own.
    const different = await call("refund_order", { order_id: booked.order_id, tickets: 2, idempotency_key: "lost-reply" }, bearer(anna.key));
    expect(different).toMatchObject({ isError: true, text: "This idempotency key was already used for a different cancellation. Use a new key for a new cancellation." });
    const belas = await call("refund_order", { order_id: other.order_id, tickets: 1, idempotency_key: "lost-reply" }, bearer(bela.key));
    expect(belas.data).toMatchObject({ replayed: false, tickets_cancelled: 1 });
    expect(await listRefundsForOrder(t.db, booked.order_id)).toHaveLength(1);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(46);
  });

  it("after the event started refuses some of the tickets — as quote_refund does — and cancels all of them for nothing", async () => {
    const anna = await customer(auth, "Anna");
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna, ev.id, 3);
    await startedAnHourAgo(ev.id);
    const refusal = "The event has started: you can no longer cancel only some of the tickets. You can still cancel the whole order, with no refund.";
    expect(await call("quote_refund", { order_id: booked.order_id, tickets: 2 }, bearer(anna.key))).toMatchObject({ isError: true, text: refusal });
    expect(await call("refund_order", { order_id: booked.order_id, tickets: 2, idempotency_key: "late-some" }, bearer(anna.key))).toMatchObject({ isError: true, text: refusal });
    expect(await listRefundsForOrder(t.db, booked.order_id)).toEqual([]);

    const q = await call("quote_refund", { order_id: booked.order_id }, bearer(anna.key));
    expect(q.data).toMatchObject({ tickets: 3, refund_eur: 0, seats_released: false, refund_window_open: false });
    const all = await call("refund_order", { order_id: booked.order_id, tickets: 3, idempotency_key: "late-all" }, bearer(anna.key));
    expect(all.data).toMatchObject({ refunded: true, status: "refunded", this_refund: { tickets: 3, refunded_eur: 0, seats_released: false } });
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(43);
  });
});

describe("quote_refund", () => {
  it("works with a read-only key, changes nothing, and is what refund_order then pays", async () => {
    const anna = await customer(auth, "Anna");
    const ro = await scopedKey(auth, anna.id, "read");
    const ev = await upcoming(t.db, { priceCents: 3_333 });
    const booked = await bookWith(anna, ev.id, 3);

    for (const tickets of [1, 2]) {
      const q = await call("quote_refund", { order_id: booked.order_id, tickets }, bearer(ro.key));
      expect(q.isError, q.text).toBe(false);
      expect(await listRefundsForOrder(t.db, booked.order_id)).toHaveLength(tickets - 1);
      const r = await call("refund_order", { order_id: booked.order_id, tickets, idempotency_key: crypto.randomUUID() }, bearer(anna.key));
      expect(r.data.this_refund).toMatchObject({ tickets: q.data.tickets, refunded_eur: q.data.refund_eur, refund_fee_kept_eur: q.data.refund_fee_eur, seats_released: q.data.seats_released });
    }
    expect((await call("refund_order", { order_id: booked.order_id, tickets: 1, idempotency_key: crypto.randomUUID() }, bearer(ro.key))).text).toMatch(/^Forbidden \(403\)/);
  });

  it("defaults to every ticket left", async () => {
    const anna = await customer(auth, "Anna");
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna, ev.id, 2);
    const q = await call("quote_refund", { order_id: booked.order_id }, bearer(anna.key));
    expect(q.data).toMatchObject({ tickets: 2, tickets_left: 2, refund_eur: 98, refund_fee_eur: 2, tickets_part_eur: 100, seats_released: true, refund_window_open: true });
  });

  it("someone else's order is not found; no key is unauthorized", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna, ev.id, 2);
    expect(await call("quote_refund", { order_id: booked.order_id }, bearer(bela.key))).toMatchObject({ isError: true, text: "Order not found." });
    // No key: the route itself answers 401, before any tool runs.
    const anonymous = await readReply(await POST(toolCallRequest("quote_refund", { order_id: booked.order_id }, {})));
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { error: { message: string } }).error.message).toMatch(/^Unauthorized \(401\)/);
  });
});

describe("the order page's cancel form", () => {
  const form = (fields: Record<string, string>) => {
    const f = new FormData();
    // What the rendered form always carries; a test that needs its own passes one.
    f.set("idempotencyKey", crypto.randomUUID());
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    return f;
  };

  it("previews and cancels the count in the box; an empty box means every ticket left", async () => {
    const anna = await customer(auth, "Anna");
    wiring.cookie = anna.cookie;
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna, ev.id, 3);

    const preview = await orderActions.quoteCancelAction(booked.order_id, "1");
    expect(preview).toEqual({ quote: { tickets: 1, windowOpen: true, grossCents: 5_000, feeCents: 100, netCents: 4_900 } });
    expect(await orderActions.cancelOrderAction({}, form({ orderId: String(booked.order_id), tickets: "1" }))).toEqual({ refundCents: preview.quote!.netCents });

    expect(await orderActions.quoteCancelAction(booked.order_id, "")).toEqual({ quote: { tickets: 2, windowOpen: true, grossCents: 10_000, feeCents: 200, netCents: 9_800 } });
    expect(await orderActions.cancelOrderAction({}, form({ orderId: String(booked.order_id), tickets: "" }))).toEqual({ refundCents: 9_800 });
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(40);
  });

  it("a double submit — the same form sent twice — cancels once and shows the same refund", async () => {
    const anna = await customer(auth, "Anna");
    wiring.cookie = anna.cookie;
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna, ev.id, 3);
    const submit = () => orderActions.cancelOrderAction({}, form({ orderId: String(booked.order_id), tickets: "1", idempotencyKey: "one-render" }));
    expect(await submit()).toEqual({ refundCents: 4_900 });
    expect(await submit()).toEqual({ refundCents: 4_900 });
    expect(await listRefundsForOrder(t.db, booked.order_id)).toHaveLength(1);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(42);
    // The next render carries a new key, and cancels again.
    expect(await orderActions.cancelOrderAction({}, form({ orderId: String(booked.order_id), tickets: "1" }))).toEqual({ refundCents: 4_900 });
    expect(await listRefundsForOrder(t.db, booked.order_id)).toHaveLength(2);
  });

  it("a submit without the form's idempotency key is refused and cancels nothing", async () => {
    const anna = await customer(auth, "Anna");
    wiring.cookie = anna.cookie;
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna, ev.id, 2);
    for (const idempotencyKey of ["", "k".repeat(101)]) {
      expect(await orderActions.cancelOrderAction({}, form({ orderId: String(booked.order_id), tickets: "1", idempotencyKey }))).toEqual({
        error: "This page is out of date. Reload it and try again.",
      });
    }
    expect(await listRefundsForOrder(t.db, booked.order_id)).toEqual([]);
  });

  it("after the event started: some of the tickets is refused in the preview and on submit; all of them goes through for nothing", async () => {
    const anna = await customer(auth, "Anna");
    wiring.cookie = anna.cookie;
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna, ev.id, 2);
    await startedAnHourAgo(ev.id);
    const refusal = { error: "The event has started: you can no longer cancel only some of the tickets. You can still cancel the whole order, with no refund." };
    expect(await orderActions.quoteCancelAction(booked.order_id, "1")).toEqual(refusal);
    expect(await orderActions.cancelOrderAction({}, form({ orderId: String(booked.order_id), tickets: "1" }))).toEqual(refusal);
    expect(await listRefundsForOrder(t.db, booked.order_id)).toEqual([]);
    expect(await orderActions.quoteCancelAction(booked.order_id, "")).toEqual({ quote: { tickets: 2, windowOpen: false, grossCents: 0, feeCents: 0, netCents: 0 } });
    expect(await orderActions.cancelOrderAction({}, form({ orderId: String(booked.order_id) }))).toEqual({ refundCents: 0 });
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(42);
  });

  it("explains a count it cannot cancel, in the preview and on submit", async () => {
    const anna = await customer(auth, "Anna");
    wiring.cookie = anna.cookie;
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna, ev.id, 2);
    for (const n of ["3", "0", "1.5", "abc"]) {
      expect(await orderActions.quoteCancelAction(booked.order_id, n), n).toEqual({ error: "This order has 2 tickets left: cancel 1 to 2." });
      expect(await orderActions.cancelOrderAction({}, form({ orderId: String(booked.order_id), tickets: n })), n).toEqual({ error: "This order has 2 tickets left: cancel 1 to 2." });
    }
    expect(await listRefundsForOrder(t.db, booked.order_id)).toEqual([]);
  });

  it("someone else's order is not found, and signed out is asked to sign in", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna, ev.id, 2);
    wiring.cookie = bela.cookie;
    expect(await orderActions.quoteCancelAction(booked.order_id, "1")).toEqual({ error: "Order not found." });
    expect(await orderActions.cancelOrderAction({}, form({ orderId: String(booked.order_id), tickets: "1" }))).toEqual({ error: "Order not found." });
    wiring.cookie = "";
    expect(await orderActions.quoteCancelAction(booked.order_id, "1")).toEqual({ error: "Sign in to cancel this order." });
  });
});
