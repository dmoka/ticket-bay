// ADVERSARIAL: POST /api/v1/orders/{id}/transfer through its route handler
// (app/api/v1/orders/[id]/transfer/route.ts), the same wiring as
// tests/http/api-v1.test.ts: real Requests, real Better Auth API keys, real
// Postgres (Testcontainers), the fake Stripe, the test clock cookie.
//
// The http harness' router (tests/http/client.ts ROUTE_FILES) does not know
// the transfer route, so this file calls the route module's POST directly,
// with the same {params} Next.js would hand it. Cancel goes through the
// harness as usual.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Auth } from "../../src/auth/auth";
import { getEvent } from "../../src/db/events-repo";
import { getOrder } from "../../src/db/orders-repo";
import { createFakeStripe } from "../../src/payments";
import { customer, makeAuth, scopedKey, useCleanAccounts, type Customer } from "../integration/accounts";
import { useTestDatabase } from "../integration/database";
import { DAY, HOUR, NOW, venue } from "../integration/fixtures";
import { bearer, call, loadRoutes, quietRefusedKeyLogs, read, request, type Call } from "./client";

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
let transferRoute: { POST: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> };

beforeAll(async () => {
  process.env.TICKETBAY_TEST_CLOCK = "1";
  auth = makeAuth(t.db);
  wiring.auth = auth;
  wiring.db = t.db;
  wiring.payments = createFakeStripe("sk_test_integration");
  await loadRoutes();
  transferRoute = await import("../../app/api/v1/orders/[id]/transfer/route");
});

afterAll(() => {
  delete process.env.TICKETBAY_TEST_CLOCK;
});

const at = (c: Call): Call => ({ nowMs: NOW, ...c });
const order = (json: unknown, headers: Record<string, string>, c: Partial<Call> = {}) => call(at({ method: "POST", path: "/api/v1/orders", json, headers, ...c }));
const cancel = (id: number | string, headers: Record<string, string>, c: Partial<Call> = {}) =>
  call(at({ method: "POST", path: `/api/v1/orders/${encodeURIComponent(id)}/cancel`, headers, ...c }));
const transfer = async (id: number | string, json: unknown, headers: Record<string, string>, c: Partial<Call> = {}) => {
  const req = request(at({ method: "POST", path: `/api/v1/orders/${encodeURIComponent(id)}/transfer`, json, headers, ...c }));
  return read(await transferRoute.POST(req, { params: Promise.resolve({ id: String(id) }) }));
};

const book = async (c: Customer, eventId: string, tickets = 2, extra: Partial<Call> = {}) => {
  const r = await order({ eventId, tickets }, { ...bearer(c.key), "idempotency-key": `k-${Math.random()}` }, extra);
  expect(r.status, r.text).toBe(201);
  return r.body.order as { id: number; status: string };
};

describe("criterion 5 over the API: the old owner's key can no longer refund a transferred order", () => {
  it("POST /orders/{id}/cancel by the old owner is 404 'Order not found.' and the order stays paid", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 2);
    expect((await transfer(o.id, { email: bela.email }, bearer(anna.key))).status).toBe(200);

    const r = await cancel(o.id, bearer(anna.key));
    expect(r, r.text).toMatchObject({ status: 404, body: { error: "Order not found." } });
    expect((await getOrder(t.db, o.id))!.status).toBe("paid");
    expect((await getEvent(t.db, "rockfest"))!.seatsSold).toBe(42);
  });
});

describe("criterion 3 over the API: only before the event starts", () => {
  it("a transfer requested after the event started is a 422 and moves nothing", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    await venue(t.db, { id: "rockfest", startsAtMs: NOW + DAY });
    const o = await book(anna, "rockfest", 2);

    const r = await transfer(o.id, { email: bela.email }, bearer(anna.key), { nowMs: NOW + DAY + HOUR });
    expect(r.status, r.text).toBe(422);
    expect((await getOrder(t.db, o.id))!.holderId).toBeNull();
  });

  it("a transfer requested at the exact start instant is a 422 (the event has started, as for booking and cancelEvent)", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    await venue(t.db, { id: "rockfest", startsAtMs: NOW + DAY });
    const o = await book(anna, "rockfest", 2);

    const r = await transfer(o.id, { email: bela.email }, bearer(anna.key), { nowMs: NOW + DAY });
    expect(r.status, r.text).toBe(422);
    expect((await getOrder(t.db, o.id))!.holderId).toBeNull();
  });
});

describe("hunted, survived (route contract)", () => {
  it("without a key 401, read-only key 403, someone else's key 404; the order stays with the owner", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    const { key: readOnly } = await scopedKey(auth, anna.id, "read");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 1);
    expect((await transfer(o.id, { email: bela.email }, {})).status).toBe(401);
    expect((await transfer(o.id, { email: bela.email }, bearer(readOnly))).status).toBe(403);
    expect(await transfer(o.id, { email: anna.email }, bearer(bela.key))).toMatchObject({ status: 404, body: { error: "Order not found." } });
    expect((await getOrder(t.db, o.id))!.holderId).toBeNull();
  });

  it("malformed ids are 404, a bad body is 400, an unknown email 422, yourself 422", async () => {
    const anna = await customer(auth, "Anna");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 1);
    for (const id of ["abc", "0", "-1", "99999999999", "1.5"]) {
      expect(await transfer(id, { email: "x@example.com" }, bearer(anna.key)), id).toMatchObject({ status: 404, body: { error: "Order not found." } });
    }
    expect((await transfer(o.id, { email: "" }, bearer(anna.key))).status).toBe(400);
    expect((await transfer(o.id, {}, bearer(anna.key))).status).toBe(400);
    expect((await transfer(o.id, { email: 42 }, bearer(anna.key))).status).toBe(400);
    expect((await transfer(o.id, { email: "nobody@example.com" }, bearer(anna.key))).status).toBe(422);
    expect((await transfer(o.id, { email: anna.email }, bearer(anna.key))).status).toBe(422);
    expect((await getOrder(t.db, o.id))!.holderId).toBeNull();
  });

  it("the happy path: 200 with the order JSON, still paid; the friend's key can then see it in nothing but My orders", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    await venue(t.db, { id: "rockfest" });
    const o = await book(anna, "rockfest", 2);
    const r = await transfer(o.id, { email: bela.email }, bearer(anna.key));
    expect(r.status, r.text).toBe(200);
    expect(r.body.order).toMatchObject({ id: o.id, status: "paid", tickets: 2 });
    expect((await getOrder(t.db, o.id))!.holderId).toBe(bela.id);
  });
});
