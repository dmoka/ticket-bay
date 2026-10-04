// The REST API (app/api/v1) end to end: real Requests into the route
// handlers, real Better Auth API keys, real services, real Postgres
// (Testcontainers). The only thing swapped is the app's process-wide
// singletons (getAuth / getDb / getPayments): they point at THIS file's test
// database and one fake-Stripe instance. Every request carries the test clock
// cookie, so "now" is the fixtures' NOW.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { count } from "drizzle-orm";
import type { Auth } from "../../src/auth/auth";
import type { Db } from "../../src/db/client";
import { getEvent } from "../../src/db/events-repo";
import { getOrder } from "../../src/db/orders-repo";
import { events, orders } from "../../src/db/schema";
import { createFakeStripe } from "../../src/payments";
import { customer, makeAuth, revokeKey, scopedKey, useCleanAccounts, type Customer } from "../integration/accounts";
import { useTestDatabase } from "../integration/database";
import { addCode, DAY, HOUR, NOW, venue } from "../integration/fixtures";
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

beforeAll(async () => {
  process.env.TICKETBAY_TEST_CLOCK = "1";
  auth = makeAuth(t.db);
  wiring.auth = auth;
  wiring.db = t.db;
  wiring.payments = createFakeStripe("sk_test_integration");
  await loadRoutes();
});

afterAll(() => {
  delete process.env.TICKETBAY_TEST_CLOCK;
});

const at = (c: Call): Call => ({ nowMs: NOW, ...c });
const get = (path: string, c: Partial<Call> = {}) => call(at({ path, ...c }));
const quote = (json: unknown, c: Partial<Call> = {}) => call(at({ method: "POST", path: "/api/v1/quote", json, ...c }));
const order = (json: unknown, headers: Record<string, string>, c: Partial<Call> = {}) => call(at({ method: "POST", path: "/api/v1/orders", json, headers, ...c }));
const cancel = (id: number | string, headers: Record<string, string>, c: Partial<Call> = {}) =>
  call(at({ method: "POST", path: `/api/v1/orders/${encodeURIComponent(id)}/cancel`, headers, ...c }));

const book = async (c: Customer, eventId: string, tickets = 2, key = `k-${Math.random()}`) => {
  const r = await order({ eventId, tickets }, { ...bearer(c.key), "idempotency-key": key });
  expect(r.status, r.text).toBe(201);
  return r.body.order as { id: number; status: string; price: { totalCents: number; ticketsCents: number; feeCents: number } };
};

async function orderCount(db: Db) {
  const [row] = await db.select({ n: count() }).from(orders);
  return row!.n;
}

describe("GET /api/v1/events", () => {
  it("lists every event with its price in cents, seats left and status", async () => {
    const soon = await venue(t.db, { id: "rockfest", startsAtMs: NOW + 10 * DAY });
    await venue(t.db, { id: "past-show", startsAtMs: NOW - DAY });

    const r = await get("/api/v1/events");
    expect(r.status).toBe(200);
    expect(r.body.events).toHaveLength(2);
    expect(r.body.events.find((e: { id: string }) => e.id === soon.id)).toEqual({
      id: "rockfest",
      name: "RockFest 2026",
      category: "concert",
      venue: "Arena",
      city: "Budapest",
      startsAt: new Date(NOW + 10 * DAY).toISOString(),
      priceCents: 5000,
      totalSeats: 100,
      seatsLeft: 60,
      status: "on-sale",
      earlyBirdEndsAt: new Date(NOW - 20 * DAY).toISOString(),
    });
    expect(r.body.events.find((e: { id: string }) => e.id === "past-show").status).toBe("past");
  });

  it("is an empty list when there are no events", async () => {
    expect(await get("/api/v1/events")).toMatchObject({ status: 200, body: { events: [] } });
  });
});

describe("GET /api/v1/events/{id}", () => {
  it("returns one event with its description and seats left", async () => {
    await venue(t.db, { id: "rockfest", description: "Loud.", seatsSold: 97 });
    const r = await get("/api/v1/events/rockfest");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: "rockfest", description: "Loud.", seatsLeft: 3, status: "few-left" });
  });

  it("an unknown id is a 404 with a JSON error", async () => {
    const r = await get("/api/v1/events/no-such-event");
    expect(r).toMatchObject({ status: 404, body: { error: "Event not found." } });
  });
});

describe("POST /api/v1/quote", () => {
  it("prices a cart in integer cents: 2 x €50 + 3% fee", async () => {
    await venue(t.db, { id: "rockfest" });
    const r = await quote({ eventId: "rockfest", tickets: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      eventId: "rockfest",
      tickets: 2,
      code: null,
      price: {
        subtotalCents: 10000,
        groupPercent: 0,
        earlyBirdPercent: 0,
        codePercent: 0,
        discountPercent: 0,
        discountCents: 0,
        ticketsCents: 10000,
        feeCents: 300,
        totalCents: 10300,
        vatCents: 2190,
      },
    });
  });

  it("applies a discount code, case-insensitive", async () => {
    await venue(t.db, { id: "rockfest" });
    await addCode(t.db, "WELCOME10", 10);
    const r = await quote({ eventId: "rockfest", tickets: 2, code: "welcome10" });
    expect(r.status).toBe(200);
    expect(r.body.code).toEqual({ code: "WELCOME10", percent: 10 });
    expect(r.body.price).toMatchObject({ codePercent: 10, discountCents: 1000, ticketsCents: 9000, feeCents: 270, totalCents: 9270 });
  });

  it("refuses what the business rules refuse with a 422 and the reason", async () => {
    await venue(t.db, { id: "rockfest", seatsSold: 99 });
    await venue(t.db, { id: "started", startsAtMs: NOW - HOUR });
    expect(await quote({ eventId: "rockfest", tickets: 2 })).toMatchObject({ status: 422, body: { error: "Not enough seats — only 1 left." } });
    expect(await quote({ eventId: "started", tickets: 1 })).toMatchObject({ status: 422, body: { error: "Sales are closed — this event has already started." } });
    expect(await quote({ eventId: "rockfest", tickets: 1, code: "NOPE" })).toMatchObject({ status: 422, body: { error: "Unknown discount code." } });
    expect(await quote({ eventId: "nowhere", tickets: 1 })).toMatchObject({ status: 404, body: { error: "Event not found." } });
  });

  it("refuses a malformed request with a 400 that names the field", async () => {
    expect(await quote({ eventId: "rockfest", tickets: 0 })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^tickets: /) } });
    expect(await quote({ eventId: "rockfest", tickets: 1.5 })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^tickets: /) } });
    expect(await quote({ eventId: "rockfest", tickets: "2" })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^tickets: /) } });
    expect(await quote({ tickets: 2 })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/^eventId: /) } });
    expect(await quote(undefined, { rawBody: "{not json" })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/must be JSON/) } });
  });
});

describe("POST /api/v1/orders", () => {
  it("books and pays with an API key: 201, the quoted total, seats taken", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    const quoted = await quote({ eventId: "rockfest", tickets: 3 });

    const r = await order({ eventId: "rockfest", tickets: 3 }, { ...bearer(anna.key), "idempotency-key": "buy-1" });
    expect(r.status, r.text).toBe(201);
    expect(r.body.replayed).toBe(false);
    expect(r.body.order).toMatchObject({ eventId: "rockfest", tickets: 3, status: "paid", price: quoted.body.price });
    expect(r.body.order.orderNumber).toBe(`TB-${String(r.body.order.id).padStart(5, "0")}`);

    const stored = (await getOrder(t.db, r.body.order.id))!;
    expect(stored).toMatchObject({ userId: anna.id, customerEmail: anna.email, customerName: "Anna", totalCents: quoted.body.price.totalCents });
    expect((await getEvent(t.db, "rockfest"))!.seatsSold).toBe(43);
  });

  it("the same Idempotency-Key replays the order: 200, same id, charged once", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    const first = await order({ eventId: "rockfest", tickets: 2 }, { ...bearer(anna.key), "idempotency-key": "retry-me" });
    const again = await order({ eventId: "rockfest", tickets: 2 }, { ...bearer(anna.key), "idempotency-key": "retry-me" });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, order: { id: first.body.order.id } });
    expect(await orderCount(t.db)).toBe(1);
    expect((await getEvent(t.db, "rockfest"))!.seatsSold).toBe(42);
  });

  it("without a key: 401 with a WWW-Authenticate header, nothing booked", async () => {
    await venue(t.db, { id: "rockfest" });
    const r = await order({ eventId: "rockfest", tickets: 1 }, { "idempotency-key": "k" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/^Bearer /);
    expect(r.body.error).toMatch(/needs an API key/);
    expect(await orderCount(t.db)).toBe(0);
  });

  it("a revoked key, an unknown key and a non-tb_ bearer are 401", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    await revokeKey(auth, anna);
    for (const headers of [bearer(anna.key), bearer("tb_neverIssued000000000000000000000000000000"), bearer("not-a-key"), { authorization: "Basic dXNlcjpwYXNz" }]) {
      const r = await order({ eventId: "rockfest", tickets: 1 }, { ...headers, "idempotency-key": "k" });
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(r.body.error).toEqual(expect.any(String));
    }
    expect(await orderCount(t.db)).toBe(0);
  });

  it("a read-only key is 403", async () => {
    const anna = await customer(auth, "Anna");
    const { key } = await scopedKey(auth, anna.id, "read");
    await venue(t.db, { id: "rockfest" });
    const r = await order({ eventId: "rockfest", tickets: 1 }, { ...bearer(key), "idempotency-key": "k" });
    expect(r).toMatchObject({ status: 403, body: { error: expect.stringMatching(/read-only/) } });
    expect(await orderCount(t.db)).toBe(0);
  });

  it("a missing or too long Idempotency-Key is 400", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    for (const extra of [{}, { "idempotency-key": "" }, { "idempotency-key": "x".repeat(101) }] as Record<string, string>[]) {
      const r = await order({ eventId: "rockfest", tickets: 1 }, { ...bearer(anna.key), ...extra });
      expect(r).toMatchObject({ status: 400, body: { error: expect.stringMatching(/Idempotency-Key/) } });
    }
    expect(await orderCount(t.db)).toBe(0);
  });

  it("sold out is a 422 and charges nothing that is kept", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest", seatsSold: 100 });
    const r = await order({ eventId: "rockfest", tickets: 1 }, { ...bearer(anna.key), "idempotency-key": "k" });
    expect(r).toMatchObject({ status: 422, body: { error: "Sold out — not enough seats left." } });
    expect(await orderCount(t.db)).toBe(0);
  });
});

describe("POST /api/v1/orders/{id}/cancel", () => {
  it("refunds the caller's own order: tickets paid minus the refund fee, seats released", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 2);

    const r = await cancel(o.id, bearer(anna.key));
    expect(r.status, r.text).toBe(200);
    // 2 x €50 = 10000 cents of tickets; refund fee 2% = 200; the 300 service fee is kept.
    expect(r.body.refund).toEqual({ refundCents: 9800, refundFeeCents: 200, seatsReleased: true });
    expect(r.body.order).toMatchObject({ id: o.id, status: "refunded", refundCents: 9800, refundedAt: new Date(NOW).toISOString() });
    expect((await getEvent(t.db, "rockfest"))!.seatsSold).toBe(40);
  });

  it("after the event starts the refund is 0 and the seats stay sold", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest", startsAtMs: NOW + DAY });
    const o = await book(anna, "rockfest", 2);
    const r = await cancel(o.id, bearer(anna.key), { nowMs: NOW + DAY });
    expect(r.status, r.text).toBe(200);
    expect(r.body.refund).toEqual({ refundCents: 0, refundFeeCents: 0, seatsReleased: false });
    expect((await getEvent(t.db, "rockfest"))!.seatsSold).toBe(42);
  });

  it("someone else's order is 404 'Order not found.' and stays paid", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 2);
    expect(await cancel(o.id, bearer(bela.key))).toMatchObject({ status: 404, body: { error: "Order not found." } });
    expect((await getOrder(t.db, o.id))!.status).toBe("paid");
  });

  it("an unknown or malformed id is 404 'Order not found.'", async () => {
    const anna = await customer(auth, "Anna");
    for (const id of ["999999", "abc", "0", "-1", "99999999999"]) {
      expect(await cancel(id, bearer(anna.key)), id).toMatchObject({ status: 404, body: { error: "Order not found." } });
    }
  });

  it("a second cancel is 422 'already refunded'", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 1);
    expect((await cancel(o.id, bearer(anna.key))).status).toBe(200);
    expect(await cancel(o.id, bearer(anna.key))).toMatchObject({ status: 422, body: { error: "This order has already been refunded." } });
  });

  it("without a key it is 401 and with a read-only key 403; the order stays paid", async () => {
    const anna = await customer(auth, "Anna");
    const { key } = await scopedKey(auth, anna.id, "read");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 1);
    expect((await cancel(o.id, {})).status).toBe(401);
    expect((await cancel(o.id, bearer(key))).status).toBe(403);
    expect((await getOrder(t.db, o.id))!.status).toBe("paid");
  });
});

describe("paths and methods", () => {
  it("a path under /api/v1 that names no endpoint is a JSON 404", async () => {
    for (const path of ["/api/v1", "/api/v1/nope", "/api/v1/events/rockfest/tickets", "/api/v1/orders/1"]) {
      const r = await get(path);
      expect(r, path).toMatchObject({ status: 404, isJson: true, body: { error: expect.stringMatching(/No such endpoint/) } });
    }
  });

  it("a method an endpoint does not answer is a JSON 405 with an Allow header", async () => {
    const r = await call(at({ method: "DELETE", path: "/api/v1/quote" }));
    expect(r).toMatchObject({ status: 405, isJson: true, body: { error: "DELETE is not allowed here. This endpoint answers POST, OPTIONS." } });
    expect(r.headers.get("allow")).toBe("POST, OPTIONS");
    expect((await get("/api/v1/orders")).status).toBe(405);
  });

  it("a path that is not valid percent-encoding is a JSON 400", async () => {
    for (const path of ["/api/v1/events/%E0%A4%A", "/api/v1/%", "/api/v1/orders/%ZZ/cancel"]) {
      expect(await get(path), path).toMatchObject({ status: 400, isJson: true, body: { error: "The URL is not valid percent-encoding." } });
    }
  });

  it("OPTIONS lists the methods as JSON", async () => {
    const r = await call(at({ method: "OPTIONS", path: "/api/v1/events/rockfest" }));
    expect(r).toMatchObject({ status: 200, body: { allow: ["GET", "OPTIONS"] } });
  });
});

describe("the test clock", () => {
  it("is ignored unless TICKETBAY_TEST_CLOCK=1: the wall clock decides", async () => {
    await t.db.insert(events).values({
      id: "tomorrow-at-wall-clock",
      name: "Show",
      category: "comedy",
      venue: "Club",
      city: "Szeged",
      startsAtMs: Date.now() + DAY,
      totalSeats: 10,
      priceCents: 1000,
      createdAtMs: Date.now() - DAY,
    });
    delete process.env.TICKETBAY_TEST_CLOCK;
    try {
      // Asked as of two days later, but the switch is off: still on sale.
      const r = await get("/api/v1/events/tomorrow-at-wall-clock", { nowMs: Date.now() + 2 * DAY });
      expect(r.body.status).toBe("on-sale");
    } finally {
      process.env.TICKETBAY_TEST_CLOCK = "1";
    }
  });
});
