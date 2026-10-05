// Partial cancels over the REST API: POST /api/v1/orders/{id}/cancel with an
// optional ticket count and its Idempotency-Key, GET /api/v1/orders/{id}/cancel-quote, and the order
// JSON's refund totals and refunds[] list. Same wiring as api-v1.test.ts: real
// Requests into the route handlers, real API keys, real Postgres.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Auth } from "../../src/auth/auth";
import { getEvent } from "../../src/db/events-repo";
import { getOrder } from "../../src/db/orders-repo";
import { createFakeStripe, type PaymentProvider } from "../../src/payments";
import { customer, makeAuth, scopedKey, useCleanAccounts, type Customer } from "../integration/accounts";
import { useTestDatabase } from "../integration/database";
import { DAY, NOW, venue } from "../integration/fixtures";
import { bearer, call, loadRoutes, quietRefusedKeyLogs, type Call } from "./client";

const wiring = vi.hoisted(() => ({ auth: undefined as unknown, db: undefined as unknown, payments: undefined as unknown }));
vi.mock("@/lib/auth", () => ({ appBaseURL: () => "http://localhost:3000", getAuth: () => wiring.auth }));
vi.mock("@/src/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/db/client")>()),
  getDb: () => wiring.db,
}));
vi.mock("@/src/payments", async () => ({ ...(await import("../../src/payments")), getPayments: () => wiring.payments }));

const t = useTestDatabase();
useCleanAccounts(t);
quietRefusedKeyLogs();

let auth: Auth;
let payments: PaymentProvider;

beforeAll(async () => {
  process.env.TICKETBAY_TEST_CLOCK = "1";
  auth = makeAuth(t.db);
  payments = createFakeStripe("sk_test_partial_http");
  wiring.auth = auth;
  wiring.db = t.db;
  wiring.payments = payments;
  await loadRoutes();
});

afterAll(() => {
  delete process.env.TICKETBAY_TEST_CLOCK;
});

const at = (c: Call): Call => ({ nowMs: NOW, ...c });
/** A cancel as a careful client sends it: every call with its own Idempotency-Key, unless `headers` brings one. */
const cancel = (id: number | string, headers: Record<string, string>, c: Partial<Call> = {}) =>
  call(at({ method: "POST", path: `/api/v1/orders/${encodeURIComponent(id)}/cancel`, headers: { "idempotency-key": crypto.randomUUID(), ...headers }, ...c }));
/** The same cancel with no Idempotency-Key header at all. */
const cancelWithoutKey = (id: number | string, headers: Record<string, string>, c: Partial<Call> = {}) =>
  call(at({ method: "POST", path: `/api/v1/orders/${encodeURIComponent(id)}/cancel`, headers, ...c }));
const cancelQuote = (id: number | string, query: string, headers: Record<string, string>, c: Partial<Call> = {}) =>
  call(at({ path: `/api/v1/orders/${encodeURIComponent(id)}/cancel-quote${query}`, headers, ...c }));

async function book(c: Customer, eventId: string, tickets: number) {
  const r = await call(at({ method: "POST", path: "/api/v1/orders", json: { eventId, tickets }, headers: { ...bearer(c.key), "idempotency-key": `k-${Math.random()}` } }));
  expect(r.status, r.text).toBe(201);
  return r.body.order as { id: number; price: { ticketsCents: number }; paymentId?: string };
}

describe("POST /api/v1/orders/{id}/cancel with a ticket count", () => {
  it("cancels that many; the order carries totals, ticketsCancelled and every refund", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 4);

    const first = await cancel(o.id, bearer(anna.key), { json: { tickets: 1 } });
    expect(first.status, first.text).toBe(200);
    expect(first.body.refund).toEqual({ tickets: 1, refundCents: 4_900, refundFeeCents: 100, seatsReleased: true });
    expect(first.body.order).toMatchObject({ id: o.id, status: "paid", ticketsCancelled: 1, refundCents: 4_900, refundedAt: new Date(NOW).toISOString() });
    expect((await getEvent(t.db, "rockfest"))!.seatsSold).toBe(43);

    const later = NOW + 3_600_000;
    const second = await cancel(o.id, bearer(anna.key), { json: { tickets: 2 }, nowMs: later });
    expect(second.body.refund).toEqual({ tickets: 2, refundCents: 9_800, refundFeeCents: 200, seatsReleased: true });
    expect(second.body.order).toMatchObject({ status: "paid", ticketsCancelled: 3, refundCents: 14_700, refundedAt: new Date(later).toISOString() });
    expect(second.body.order.refunds).toEqual([
      { tickets: 1, refundCents: 4_900, refundFeeCents: 100, seatsReleased: true, reason: "customer", refundedAt: new Date(NOW).toISOString() },
      { tickets: 2, refundCents: 9_800, refundFeeCents: 200, seatsReleased: true, reason: "customer", refundedAt: new Date(later).toISOString() },
    ]);

    // An empty body cancels every ticket left.
    const rest = await cancel(o.id, bearer(anna.key), { nowMs: later });
    expect(rest.body.refund).toMatchObject({ tickets: 1, refundCents: 4_900 });
    expect(rest.body.order).toMatchObject({ status: "refunded", ticketsCancelled: 4, refundCents: 19_600 });
    expect((await getEvent(t.db, "rockfest"))!.seatsSold).toBe(40);
  });

  it("an order nobody cancelled shows refundCents null, refundedAt null, ticketsCancelled 0 and no refunds", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    const r = await call(at({ method: "POST", path: "/api/v1/orders", json: { eventId: "rockfest", tickets: 2 }, headers: { ...bearer(anna.key), "idempotency-key": "fresh" } }));
    expect(r.body.order).toMatchObject({ refundCents: null, refundedAt: null, ticketsCancelled: 0, refunds: [] });
  });

  it("a replayed booking of an order cancelled since shows its refunds", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    const place = () => call(at({ method: "POST", path: "/api/v1/orders", json: { eventId: "rockfest", tickets: 2 }, headers: { ...bearer(anna.key), "idempotency-key": "same" } }));
    const o = (await place()).body.order;
    await cancel(o.id, bearer(anna.key), { json: { tickets: 1 } });
    const replay = await place();
    expect(replay.status).toBe(200);
    expect(replay.body.order).toMatchObject({ ticketsCancelled: 1, refundCents: 4_900 });
    expect(replay.body.order.refunds).toHaveLength(1);
  });

  it("too many, zero or a fraction: 422 or 400 saying what to send, and nothing changes", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 2);
    expect(await cancel(o.id, bearer(anna.key), { json: { tickets: 3 } })).toMatchObject({
      status: 422,
      body: { error: "This order has 2 tickets left: cancel 1 to 2." },
    });
    for (const json of [{ tickets: 0 }, { tickets: 1.5 }, { tickets: "1" }, { tickets: null }]) {
      const r = await cancel(o.id, bearer(anna.key), { json });
      expect(r.status, JSON.stringify(json)).toBe(400);
      expect(r.body.error, JSON.stringify(json)).toMatch(/^tickets: /);
    }
    const junk = await cancel(o.id, bearer(anna.key), { rawBody: "tickets=1" });
    expect(junk).toMatchObject({ status: 400, body: { error: 'The body must be JSON, e.g. {"tickets": 2}, or empty.' } });
    expect((await getEvent(t.db, "rockfest"))!.seatsSold).toBe(42);
  });
});

describe("POST /api/v1/orders/{id}/cancel and the Idempotency-Key header", () => {
  const NEEDS_KEY = "Send an Idempotency-Key header (1-100 characters, unique per cancellation; reuse it only to retry the same cancellation).";

  it("a ticket count without a key is 400 and cancels nothing; an empty or too long key is 400 with or without a count", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 2);
    expect(await cancelWithoutKey(o.id, bearer(anna.key), { json: { tickets: 1 } })).toMatchObject({ status: 400, body: { error: NEEDS_KEY } });
    for (const key of ["", "   ", "k".repeat(101)]) {
      for (const c of [{ json: { tickets: 1 } }, {}]) {
        expect(await cancel(o.id, { ...bearer(anna.key), "idempotency-key": key }, c), key).toMatchObject({ status: 400, body: { error: NEEDS_KEY } });
      }
    }
    expect((await getEvent(t.db, "rockfest"))!.seatsSold).toBe(42);
  });

  it("without a count the key is optional: every ticket left is cancelled, and a second call is refused", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 2);
    const r = await cancelWithoutKey(o.id, bearer(anna.key));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ replayed: false, refund: { tickets: 2, refundCents: 9_800 }, order: { status: "refunded" } });
    expect(await cancelWithoutKey(o.id, bearer(anna.key))).toMatchObject({ status: 422, body: { error: "This order has already been refunded." } });
  });

  it("the same key twice answers with the first cancellation, replayed, and cancels nothing more", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 4);
    const send = () => cancel(o.id, { ...bearer(anna.key), "idempotency-key": "timed-out" }, { json: { tickets: 1 } });

    const first = await send();
    expect(first.body).toMatchObject({ replayed: false, refund: { tickets: 1, refundCents: 4_900, refundFeeCents: 100, seatsReleased: true } });
    const again = await send();
    expect(again.status, again.text).toBe(200);
    expect(again.body).toEqual({ ...first.body, replayed: true });
    expect((await getEvent(t.db, "rockfest"))!.seatsSold).toBe(43);
    expect(payments.getCharge((await getOrder(t.db, o.id))!.paymentId)!.refundedCents).toBe(4_900);

    // A full cancel with a key replays too, instead of "already refunded".
    const rest = () => cancel(o.id, { ...bearer(anna.key), "idempotency-key": "the-rest" });
    const all = await rest();
    expect(all.body).toMatchObject({ replayed: false, refund: { tickets: 3 }, order: { status: "refunded" } });
    expect((await rest()).body).toEqual({ ...all.body, replayed: true });
    expect((await getEvent(t.db, "rockfest"))!.seatsSold).toBe(40);
  });

  it("a key already used for another cancellation is 422; another customer's same key is their own", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    await venue(t.db, { id: "rockfest" });
    const a = await book(anna, "rockfest", 3);
    const a2 = await book(anna, "rockfest", 3);
    const b = await book(bela, "rockfest", 3);
    const withKey = (c: Customer) => ({ ...bearer(c.key), "idempotency-key": "shared" });
    expect((await cancel(a.id, withKey(anna), { json: { tickets: 1 } })).status).toBe(200);
    const refusal = { status: 422, body: { error: "This idempotency key was already used for a different cancellation. Use a new key for a new cancellation." } };
    expect(await cancel(a.id, withKey(anna), { json: { tickets: 2 } })).toMatchObject(refusal);
    expect(await cancel(a2.id, withKey(anna), { json: { tickets: 1 } })).toMatchObject(refusal);
    expect(await cancel(b.id, withKey(bela), { json: { tickets: 1 } })).toMatchObject({ status: 200, body: { replayed: false, order: { id: b.id, ticketsCancelled: 1 } } });
    expect((await getEvent(t.db, "rockfest"))!.seatsSold).toBe(47);
  });
});

describe("after the event has started", () => {
  it("cancelling some of the tickets is 422 on the cancel and on its quote; every ticket left still cancels, for nothing", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest", startsAtMs: NOW + DAY });
    const o = await book(anna, "rockfest", 3);
    expect((await cancel(o.id, bearer(anna.key), { json: { tickets: 1 }, nowMs: NOW + DAY - 1 })).status).toBe(200);

    const late = { nowMs: NOW + DAY };
    const refusal = {
      status: 422,
      body: { error: "The event has started: you can no longer cancel only some of the tickets. You can still cancel all 2 tickets left, with no refund." },
    };
    expect(await cancelQuote(o.id, "?tickets=1", bearer(anna.key), late)).toMatchObject(refusal);
    expect(await cancel(o.id, bearer(anna.key), { json: { tickets: 1 }, ...late })).toMatchObject(refusal);
    expect((await getEvent(t.db, "rockfest"))!.seatsSold).toBe(42);

    const q = await cancelQuote(o.id, "?tickets=2", bearer(anna.key), late);
    expect(q.body).toMatchObject({ ticketsLeft: 2, refundWindowOpen: false, refund: { tickets: 2, refundCents: 0, refundFeeCents: 0, seatsReleased: false } });
    const all = await cancel(o.id, bearer(anna.key), { json: { tickets: 2 }, ...late });
    expect(all.body.refund).toEqual(q.body.refund);
    expect(all.body.order).toMatchObject({ status: "refunded", ticketsCancelled: 3, refundCents: 4_900 });
    expect((await getEvent(t.db, "rockfest"))!.seatsSold).toBe(42);
  });
});

describe("GET /api/v1/orders/{id}/cancel-quote", () => {
  it("is exactly what the cancel then pays, and changes nothing", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "odd", priceCents: 3_333 });
    const o = await book(anna, "odd", 3);
    for (const n of [1, 1, null]) {
      const q = await cancelQuote(o.id, n === null ? "" : `?tickets=${n}`, bearer(anna.key));
      expect(q.status, q.text).toBe(200);
      expect(await cancelQuote(o.id, n === null ? "" : `?tickets=${n}`, bearer(anna.key))).toMatchObject({ body: q.body });
      const c = await cancel(o.id, bearer(anna.key), n === null ? {} : { json: { tickets: n } });
      expect(c.body.refund).toEqual(q.body.refund);
    }
  });

  it("defaults to every ticket left and reports the window", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest", startsAtMs: NOW + DAY });
    const o = await book(anna, "rockfest", 2);
    expect((await cancelQuote(o.id, "", bearer(anna.key))).body).toEqual({
      orderId: o.id,
      ticketsLeft: 2,
      refundWindowOpen: true,
      refund: { tickets: 2, refundCents: 9_800, refundFeeCents: 200, seatsReleased: true },
    });
    expect((await cancelQuote(o.id, "", bearer(anna.key), { nowMs: NOW + DAY })).body).toEqual({
      orderId: o.id,
      ticketsLeft: 2,
      refundWindowOpen: false,
      refund: { tickets: 2, refundCents: 0, refundFeeCents: 0, seatsReleased: false },
    });
  });

  it("a read-only key may quote but not cancel; no key is 401; someone else's order is 404", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 2);
    const ro = await scopedKey(auth, anna.id, "read");
    expect((await cancelQuote(o.id, "?tickets=1", bearer(ro.key))).status).toBe(200);
    expect((await cancel(o.id, bearer(ro.key), { json: { tickets: 1 } })).status).toBe(403);
    expect((await cancelQuote(o.id, "?tickets=1", {})).status).toBe(401);
    expect(await cancelQuote(o.id, "", bearer(bela.key))).toMatchObject({ status: 404, body: { error: "Order not found." } });
    expect(await cancelQuote("abc", "", bearer(anna.key))).toMatchObject({ status: 404, body: { error: "Order not found." } });
  });

  it("a bad ticket count is 400; more than are left is 422; a refunded order is 422", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 2);
    for (const q of ["?tickets=0", "?tickets=1.5", "?tickets=abc", "?tickets=", "?tickets=-1", "?tickets=99999"]) {
      expect(await cancelQuote(o.id, q, bearer(anna.key)), q).toMatchObject({
        status: 400,
        body: { error: "tickets: must be a whole number of tickets, at least 1, e.g. ?tickets=2" },
      });
    }
    expect(await cancelQuote(o.id, "?tickets=3", bearer(anna.key))).toMatchObject({ status: 422, body: { error: "This order has 2 tickets left: cancel 1 to 2." } });
    await cancel(o.id, bearer(anna.key));
    expect(await cancelQuote(o.id, "", bearer(anna.key))).toMatchObject({ status: 422, body: { error: "This order has already been refunded." } });
  });

  it("answers GET only", async () => {
    const anna = await customer(auth, "Anna");
    const r = await call(at({ method: "POST", path: "/api/v1/orders/1/cancel-quote", headers: bearer(anna.key) }));
    expect(r.status).toBe(405);
    expect(r.body.error).toContain("GET");
  });
});
