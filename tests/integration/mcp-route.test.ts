// The remote MCP endpoint (app/api/mcp/route.ts) end to end: a real Request
// into the route's POST, real Better Auth API keys, real tools, real Postgres
// (Testcontainers). The only thing swapped is the route's process-wide
// singletons (getAuth / getDb / getPayments): they point at THIS file's test
// database and one fake-Stripe instance instead of the dev server's. The
// database itself is never mocked.
//
// The route uses the real clock (Date.now()), so events here are placed
// relative to Date.now(), not the fixtures' NOW.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { count, eq } from "drizzle-orm";
import { createFakeStripe, type PaymentProvider } from "../../src/payments";
import type { Auth } from "../../src/auth/auth";
import type { Db } from "../../src/db/client";
import { getEvent } from "../../src/db/events-repo";
import { getOrder } from "../../src/db/orders-repo";
import { events, orders, user } from "../../src/db/schema";
import { resolveCaller } from "../../src/mcp/caller";
import { UNAUTHENTICATED_MESSAGE } from "../../src/mcp/tools";
import { useTestDatabase } from "./database";
import { DAY, HOUR, venue } from "./fixtures";
import {
  BASE_URL,
  ban,
  bearer,
  customer,
  expireKey,
  makeAdmin,
  makeAuth,
  readReply,
  revokeKey,
  rpcRequest,
  toolCallRequest,
  toolResult,
  useCleanAccounts,
  type Customer,
} from "./accounts";

const wiring = vi.hoisted(() => ({ auth: undefined as unknown, db: undefined as unknown, payments: undefined as unknown }));
vi.mock("@/lib/auth", () => ({ appBaseURL: () => "http://localhost:3000", getAuth: () => wiring.auth }));
vi.mock("@/src/db/client", () => ({ getDb: () => wiring.db }));
vi.mock("@/src/payments", async () => ({ ...(await import("../../src/payments")), getPayments: () => wiring.payments }));
vi.mock("@/src/mcp/caller", () => import("../../src/mcp/caller"));
vi.mock("@/src/mcp/tools", () => import("../../src/mcp/tools"));
vi.mock("@/src/auth/auth", () => import("../../src/auth/auth"));

const t = useTestDatabase();
useCleanAccounts(t);

let auth: Auth;
let POST: (r: Request) => Promise<Response>;

beforeAll(async () => {
  auth = makeAuth(t.db);
  wiring.auth = auth;
  wiring.db = t.db;
  wiring.payments = createFakeStripe("sk_test_integration") satisfies PaymentProvider;
  ({ POST } = await import("../../app/api/mcp/route"));
});

const call = async (name: string, args: object = {}, headers: Record<string, string> = {}) => readReply(await POST(toolCallRequest(name, args, headers)));

/** An event 10 days out (no early-bird): 100 seats, 40 sold, €50.00. */
const upcoming = (db: Db, over: Parameters<typeof venue>[1] = {}) =>
  venue(db, { startsAtMs: Date.now() + 10 * DAY, createdAtMs: Date.now() - 30 * DAY, ...over });

async function orderCount(db: Db) {
  const [row] = await db.select({ n: count() }).from(orders);
  return row!.n;
}

async function book(c: Customer, eventId: string, quantity = 2, extra: object = {}) {
  const r = toolResult(await call("book_tickets", { event_id: eventId, quantity, ...extra }, bearer(c.key)));
  expect(r.isError, r.text).toBe(false);
  return r.data as { order_id: number; order_number: string; replayed: boolean; status: string; total_paid_eur: number };
}

// ---- 1. API key → user ----------------------------------------------------------

describe("an API key resolves to exactly its owner", () => {
  it("each key maps to the user who created it, with that user's identity", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    const deps = { auth, db: t.db };

    const a = await resolveCaller(deps, new Request(`${BASE_URL}/api/mcp`, { headers: bearer(anna.key) }));
    const b = await resolveCaller(deps, new Request(`${BASE_URL}/api/mcp`, { headers: bearer(bela.key) }));

    expect(a).toEqual({ ok: true, caller: { userId: anna.id, email: anna.email, name: "Anna", role: "user", scopes: ["tickets:read", "tickets:write"] } });
    expect(b).toEqual({ ok: true, caller: { userId: bela.id, email: bela.email, name: "Bela", role: "user", scopes: ["tickets:read", "tickets:write"] } });
  });

  it("my_orders over the route shows the key owner's account", async () => {
    const anna = await customer(auth, "Anna");
    const r = toolResult(await call("my_orders", {}, bearer(anna.key)));
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ customer: anna.email, count: 0 });
  });

  it("no Authorization header is anonymous (caller null), not an error", async () => {
    const r = await resolveCaller({ auth, db: t.db }, new Request(`${BASE_URL}/api/mcp`));
    expect(r).toEqual({ ok: true, caller: null });
  });
});

describe("a bad credential is refused — never downgraded to anonymous", () => {
  const refusedEverywhere = async (headers: Record<string, string>, expectMsg: RegExp) => {
    const deps = { auth, db: t.db };
    const resolved = await resolveCaller(deps, new Request(`${BASE_URL}/api/mcp`, { headers }));
    expect(resolved.ok).toBe(false);

    // Even a PUBLIC tool is refused: an agent with a dead key must notice.
    for (const [tool, args] of [
      ["list_events", {}],
      ["my_orders", {}],
    ] as const) {
      const reply = await call(tool, args, headers);
      expect(reply.status, `${tool} ${JSON.stringify(reply.body)}`).toBe(401);
      expect(reply.wwwAuthenticate).toMatch(/^Bearer /);
      expect((reply.body as { error: { code: number; message: string } }).error.code).toBe(-32001);
      expect((reply.body as { error: { message: string } }).error.message).toMatch(expectMsg);
    }
  };

  it("a revoked (deleted) key", async () => {
    const anna = await customer(auth, "Anna");
    // works before revocation
    expect(toolResult(await call("my_orders", {}, bearer(anna.key))).isError).toBe(false);
    await revokeKey(auth, anna);
    await refusedEverywhere(bearer(anna.key), /API key does not work/);
  });

  it("an unknown tb_ key", async () => {
    await customer(auth, "Anna");
    await refusedEverywhere(bearer("tb_thisKeyWasNeverIssuedByTicketBay0000000000000000000000000000"), /API key does not work/);
  });

  it("a key whose expiry has passed", async () => {
    const anna = await customer(auth, "Anna");
    await expireKey(t.db, anna.keyId);
    await refusedEverywhere(bearer(anna.key), /API key does not work/);
  });

  it("a valid key whose owner is banned", async () => {
    const anna = await customer(auth, "Anna");
    await ban(t.db, anna.id);
    await refusedEverywhere(bearer(anna.key), /not active/);
  });

  it("a valid key whose owner account was deleted", async () => {
    const anna = await customer(auth, "Anna");
    await t.db.delete(user).where(eq(user.id, anna.id));
    await refusedEverywhere(bearer(anna.key), /not active|does not work/);
  });

  it("any bearer that is not a tb_ key (OAuth is not supported): garbage, a JWT-shaped token, a DPoP token", async () => {
    await refusedEverywhere(bearer("not.a.jwt"), /Bearer tb_/);
    const jwtLike = [{ alg: "EdDSA", typ: "at+jwt" }, { sub: "someone", scope: "tickets:read tickets:write" }]
      .map((p) => Buffer.from(JSON.stringify(p)).toString("base64url"))
      .concat("sig")
      .join(".");
    await refusedEverywhere(bearer(jwtLike), /Bearer tb_/);
    await refusedEverywhere({ authorization: "DPoP tb_whatever" }, /Bearer tb_/);
    await refusedEverywhere(bearer("TB_uppercase_prefix"), /Bearer tb_/);
  });

  it("a malformed Authorization header", async () => {
    await refusedEverywhere({ authorization: "Basic dXNlcjpwYXNz" }, /Bearer tb_/);
    await refusedEverywhere({ authorization: "Bearer" }, /Bearer tb_/);
  });

  it("a refused key books nothing", async () => {
    const anna = await customer(auth, "Anna");
    const ev = await upcoming(t.db);
    await revokeKey(auth, anna);
    const reply = await call("book_tickets", { event_id: ev.id, quantity: 1 }, bearer(anna.key));
    expect(reply.status).toBe(401);
    expect(await orderCount(t.db)).toBe(0);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(40);
  });
});

// ---- 3. Public vs private without a caller ------------------------------------

describe("anonymous callers", () => {
  it("can use every public tool", async () => {
    const ev = await upcoming(t.db);

    const list = toolResult(await call("list_events"));
    expect(list.isError).toBe(false);
    expect(list.data.events.map((e: { id: string }) => e.id)).toEqual([ev.id]);

    const got = toolResult(await call("get_event", { event_id: ev.id }));
    expect(got.isError).toBe(false);
    expect(got.data).toMatchObject({ id: ev.id, seats_left: 60, base_price_eur: 50 });

    const q = toolResult(await call("quote_price", { event_id: ev.id, quantity: 2 }));
    expect(q.isError).toBe(false);
    expect(q.data.total_eur).toBe(103); // 2 × €50 + 3% fee
  });

  it.each([
    ["book_tickets", { event_id: "any", quantity: 1 }],
    ["my_orders", {}],
    ["refund_order", { order_id: 1 }],
    ["cancel_event", { event_id: "any" }],
  ])("get a 401 with the readable message from %s", async (tool, args) => {
    const reply = await call(tool, args);
    expect(reply.status).toBe(401);
    expect(reply.wwwAuthenticate).toMatch(/^Bearer /);
    expect(reply.body).toMatchObject({ jsonrpc: "2.0", error: { code: -32001, message: UNAUTHENTICATED_MESSAGE } });
  });

  it("cannot book by hiding book_tickets behind a public call in a JSON-RPC batch", async () => {
    const ev = await upcoming(t.db);
    const res = await POST(
      rpcRequest([
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_event", arguments: { event_id: ev.id } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "book_tickets", arguments: { event_id: ev.id, quantity: 3 } } },
      ]),
    );
    await res.text();
    expect(await orderCount(t.db)).toBe(0);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(40);
  });
});

// ---- 2. Ownership ---------------------------------------------------------------

describe("orders belong to the account that booked them", () => {
  it("B cannot see or refund A's order; the order stays paid; A can refund it", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    const ev = await upcoming(t.db);

    const booked = await book(anna, ev.id, 2);
    const stored = (await getOrder(t.db, booked.order_id))!;
    expect(stored.userId).toBe(anna.id);
    expect(stored.customerEmail).toBe(anna.email);

    // B does not see it.
    const bList = toolResult(await call("my_orders", {}, bearer(bela.key)));
    expect(bList.data).toMatchObject({ customer: bela.email, count: 0, orders: [] });

    // B cannot refund it, by numeric id or by order number — and learns nothing.
    for (const id of [booked.order_id, booked.order_number, String(booked.order_id)]) {
      const r = toolResult(await call("refund_order", { order_id: id }, bearer(bela.key)));
      expect(r.isError).toBe(true);
      expect(r.text).toBe("Order not found.");
    }
    const still = (await getOrder(t.db, booked.order_id))!;
    expect(still.status).toBe("paid");
    expect(still.refundedAtMs).toBeNull();
    expect(still.refundId).toBeNull();
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(42);

    // A sees it and refunds it.
    const aList = toolResult(await call("my_orders", {}, bearer(anna.key)));
    expect(aList.data.orders.map((o: { order_id: number }) => o.order_id)).toEqual([booked.order_id]);
    const promised = aList.data.orders[0].refund_if_cancelled_now_eur;

    const refund = toolResult(await call("refund_order", { order_id: booked.order_number }, bearer(anna.key)));
    expect(refund.isError, refund.text).toBe(false);
    expect(refund.data).toMatchObject({ refunded: true, status: "refunded", order_id: booked.order_id, refunded_eur: promised });
    const after = (await getOrder(t.db, booked.order_id))!;
    expect(after.status).toBe("refunded");
    expect(after.refundId).not.toBeNull();
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(40);
  });

  it("an unknown order id and a nonsense id are 'not found' for everyone", async () => {
    const anna = await customer(auth, "Anna");
    for (const id of [999_999, "TB-99999"]) {
      const r = toolResult(await call("refund_order", { order_id: id }, bearer(anna.key)));
      expect(r).toMatchObject({ isError: true, text: "Order not found." });
    }
  });
});

describe("idempotent replay across users", () => {
  it("the same idempotency_key from two users books two separate orders, one per owner", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    const ev = await upcoming(t.db);

    const a = await book(anna, ev.id, 1, { idempotency_key: "same-key" });
    const b = await book(bela, ev.id, 1, { idempotency_key: "same-key" });
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
    expect(b.order_id).not.toBe(a.order_id);
    expect((await getOrder(t.db, a.order_id))!.userId).toBe(anna.id);
    expect((await getOrder(t.db, b.order_id))!.userId).toBe(bela.id);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(42);
  });

  it("a retry by the same user replays the order: one order, seats taken once", async () => {
    const anna = await customer(auth, "Anna");
    const ev = await upcoming(t.db);
    const first = await book(anna, ev.id, 3, { idempotency_key: "retry-me" });
    const again = await book(anna, ev.id, 3, { idempotency_key: "retry-me" });
    expect(again).toMatchObject({ replayed: true, order_id: first.order_id });
    expect(await orderCount(t.db)).toBe(1);
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(43);
  });
});

describe("cancel_event (admin) only prepares the cancellation", () => {
  it("a normal customer gets 403 and nothing changes", async () => {
    const anna = await customer(auth, "Anna");
    const ev = await upcoming(t.db);
    const r = toolResult(await call("cancel_event", { event_id: ev.id }, bearer(anna.key)));
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/403/);
    expect((await getEvent(t.db, ev.id))!.cancelledAtMs).toBeNull();
  });

  it("an admin is refused for an event that has already started; nothing changes", async () => {
    const anna = await customer(auth, "Anna");
    const boss = await customer(auth, "Boss");
    await makeAdmin(t.db, boss.id);
    const ev = await upcoming(t.db);
    const booked = await book(anna, ev.id, 2);
    await t.db.update(events).set({ startsAtMs: Date.now() - HOUR }).where(eq(events.id, ev.id));
    const r = toolResult(await call("cancel_event", { event_id: ev.id }, bearer(boss.key)));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already started/);
    expect(r.text).not.toContain("confirm");
    expect((await getEvent(t.db, ev.id))!.cancelledAtMs).toBeNull();
    expect((await getOrder(t.db, booked.order_id))!.status).toBe("paid");
  });

  it("an admin gets the impact and a confirm link; the event is NOT cancelled and no order is refunded", async () => {
    const anna = await customer(auth, "Anna");
    const boss = await customer(auth, "Boss");
    await makeAdmin(t.db, boss.id);
    const ev = await upcoming(t.db);
    const booked = await book(anna, ev.id, 2);

    const r = toolResult(await call("cancel_event", { event_id: ev.id }, bearer(boss.key)));
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ cancelled: false, impact_if_confirmed: { paid_orders_refunded: 1, tickets_refunded: 2 } });
    expect(r.data.confirm_url).toBe(`http://localhost:3000/admin/events/${ev.id}/cancel?via=mcp`);

    expect((await getEvent(t.db, ev.id))!.cancelledAtMs).toBeNull();
    expect((await getOrder(t.db, booked.order_id))!.status).toBe("paid");
  });
});
