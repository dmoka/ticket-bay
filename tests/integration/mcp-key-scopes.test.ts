// API-key scopes, key creation / rotation (the real Settings → Developers
// server actions), search_docs and the cancel_event link — through the route's
// POST with a real Request, real Better Auth keys, real Postgres
// (Testcontainers). Only process-wide singletons are pointed at this file's
// instances: getAuth / getDb / getPayments / getSession, and Next's
// request-scoped headers() (the signed-in browser's cookie). The database is
// never mocked.
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { count, eq } from "drizzle-orm";
import { createFakeStripe } from "../../src/payments";
import type { Auth } from "../../src/auth/auth";
import type { Db } from "../../src/db/client";
import { getEvent } from "../../src/db/events-repo";
import { getOrder } from "../../src/db/orders-repo";
import { apikey, orders } from "../../src/db/schema";
import { resolveCaller } from "../../src/mcp/caller";
import { useTestDatabase } from "./database";
import { DAY, venue } from "./fixtures";
import { bearer, customer, makeAdmin, makeAuth, readReply, scopedKey, toolCallRequest, toolResult, useCleanAccounts, type Customer } from "./accounts";

const wiring = vi.hoisted(() => ({ auth: undefined as any, db: undefined as unknown, payments: undefined as unknown, cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(wiring.cookie ? { cookie: wiring.cookie } : {}) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth", () => ({
  appBaseURL: () => "http://localhost:3000",
  getAuth: () => wiring.auth,
  getSession: () => wiring.auth.api.getSession({ headers: new Headers(wiring.cookie ? { cookie: wiring.cookie } : {}) }),
}));
vi.mock("@/src/db/client", () => ({ getDb: () => wiring.db }));
vi.mock("@/src/payments", async () => ({ ...(await import("../../src/payments")), getPayments: () => wiring.payments }));
vi.mock("@/src/mcp/caller", () => import("../../src/mcp/caller"));
vi.mock("@/src/mcp/tools", () => import("../../src/mcp/tools"));
vi.mock("@/src/auth/auth", () => import("../../src/auth/auth"));

const t = useTestDatabase();
useCleanAccounts(t);

let auth: Auth;
let POST: (r: Request) => Promise<Response>;
let actions: typeof import("../../app/(public)/settings/developers/actions");

beforeAll(async () => {
  auth = makeAuth(t.db);
  wiring.auth = auth;
  wiring.db = t.db;
  wiring.payments = createFakeStripe("sk_test_integration");
  ({ POST } = await import("../../app/api/mcp/route"));
  actions = await import("../../app/(public)/settings/developers/actions");
});

const call = async (name: string, args: object = {}, headers: Record<string, string> = {}) => readReply(await POST(toolCallRequest(name, args, headers)));

/** An event 10 days out (no early-bird): 100 seats, 40 sold, €50.00. */
const upcoming = (db: Db, over: Parameters<typeof venue>[1] = {}) =>
  venue(db, { startsAtMs: Date.now() + 10 * DAY, createdAtMs: Date.now() - 30 * DAY, ...over });

async function orderCount(db: Db) {
  const [row] = await db.select({ n: count() }).from(orders);
  return row!.n;
}

async function bookWith(key: string, eventId: string, quantity = 2) {
  const r = toolResult(await call("book_tickets", { event_id: eventId, quantity }, bearer(key)));
  expect(r.isError, r.text).toBe(false);
  return r.data as { order_id: number; order_number: string; status: string };
}

async function signedIn(c: Customer) {
  wiring.cookie = c.cookie;
}

describe("a read-only key", () => {
  it("browses and lists its own orders, but cannot book, refund or cancel — and nothing is written", async () => {
    const anna = await customer(auth, "Anna");
    await makeAdmin(t.db, anna.id); // even an admin's read-only key cannot reach cancel_event
    const ro = await scopedKey(auth, anna.id, "read");
    const rw = await scopedKey(auth, anna.id, "read-write");
    const ev = await upcoming(t.db);
    const booked = await bookWith(rw.key, ev.id, 2);

    const caller = await resolveCaller({ auth, db: t.db }, toolCallRequest("my_orders", {}, bearer(ro.key)));
    expect(caller).toMatchObject({ ok: true, caller: { userId: anna.id, scopes: ["tickets:read"] } });

    const list = toolResult(await call("list_events", {}, bearer(ro.key)));
    expect(list.isError).toBe(false);
    expect(list.data.events.map((e: { id: string }) => e.id)).toEqual([ev.id]);
    expect(toolResult(await call("get_event", { event_id: ev.id }, bearer(ro.key))).isError).toBe(false);

    const mine = toolResult(await call("my_orders", {}, bearer(ro.key)));
    expect(mine.isError, mine.text).toBe(false);
    expect(mine.data).toMatchObject({ customer: anna.email, count: 1 });

    for (const [tool, args] of [
      ["book_tickets", { event_id: ev.id, quantity: 1 }],
      ["refund_order", { order_id: booked.order_id }],
      ["cancel_event", { event_id: ev.id }],
    ] as const) {
      const r = toolResult(await call(tool, args, bearer(ro.key)));
      expect(r.isError, `${tool}: ${r.text}`).toBe(true);
      expect(r.text).toMatch(/^Forbidden \(403\)/);
      expect(r.text).toContain("read-only");
      expect(r.text).toContain("tickets:write");
    }

    expect(await orderCount(t.db)).toBe(1);
    const order = (await getOrder(t.db, booked.order_id))!;
    expect(order).toMatchObject({ status: "paid", refundCents: null, refundId: null });
    expect((await getEvent(t.db, ev.id))!).toMatchObject({ seatsSold: 42, cancelledAtMs: null });
  });

  it("a key with no tickets permission at all is refused even my_orders", async () => {
    const anna = await customer(auth, "Anna");
    const odd = await auth.api.createApiKey({ body: { name: "odd", userId: anna.id, permissions: { other: ["thing"] } } });
    const r = toolResult(await call("my_orders", {}, bearer(odd.key)));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Forbidden \(403\)/);
    expect(r.text).not.toContain(anna.email);
  });
});

describe("a read & write key", () => {
  it("books, lists and refunds", async () => {
    const anna = await customer(auth, "Anna");
    const rw = await scopedKey(auth, anna.id, "read-write");
    const ev = await upcoming(t.db);
    const booked = await bookWith(rw.key, ev.id, 2);
    expect((await getOrder(t.db, booked.order_id))!.userId).toBe(anna.id);
    const refund = toolResult(await call("refund_order", { order_id: booked.order_id }, bearer(rw.key)));
    expect(refund.isError, refund.text).toBe(false);
    expect((await getOrder(t.db, booked.order_id))!.status).toBe("refunded");
  });

  it("a key created without permissions defaults to read & write (server path and session path)", async () => {
    const anna = await customer(auth, "Anna"); // customer() creates its key over the session, without permissions
    const server = await auth.api.createApiKey({ body: { name: "plain", userId: anna.id } });
    for (const key of [anna.key, server.key]) {
      const r = await resolveCaller({ auth, db: t.db }, toolCallRequest("my_orders", {}, bearer(key)));
      expect(r).toMatchObject({ ok: true, caller: { scopes: ["tickets:read", "tickets:write"] } });
    }
    const ev = await upcoming(t.db);
    await bookWith(server.key, ev.id, 1);
  });
});

describe("a customer cannot give themselves (or others) a key they should not have", () => {
  it("permissions on a session request are refused", async () => {
    const anna = await customer(auth, "Anna");
    await expect(
      auth.api.createApiKey({ body: { name: "sneaky", permissions: { tickets: ["read", "write"], admin: ["all"] } }, headers: new Headers({ cookie: anna.cookie }) }),
    ).rejects.toThrow();
  });

  it("a session request naming another user's id does not create a key for that user", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    const before = await t.db.select().from(apikey).where(eq(apikey.referenceId, bela.id));
    const made = await auth.api
      .createApiKey({ body: { name: "for-bela", userId: bela.id }, headers: new Headers({ cookie: anna.cookie }) })
      .catch(() => null);
    const after = await t.db.select().from(apikey).where(eq(apikey.referenceId, bela.id));
    expect(after.length).toBe(before.length);
    if (made) {
      const r = await resolveCaller({ auth, db: t.db }, toolCallRequest("my_orders", {}, bearer(made.key)));
      expect(r).toMatchObject({ ok: true, caller: { userId: anna.id } });
    }
  });
});

describe("Settings → Developers actions (real server actions)", () => {
  it("createKeyAction makes a read-only key that the MCP endpoint treats as read-only", async () => {
    const anna = await customer(auth, "Anna");
    await signedIn(anna);
    const made = await actions.createKeyAction("Claude Code", "read");
    expect(made).toMatchObject({ ok: true, name: "Claude Code" });
    if (!made.ok) throw new Error(made.error);
    const r = await resolveCaller({ auth, db: t.db }, toolCallRequest("my_orders", {}, bearer(made.key)));
    expect(r).toMatchObject({ ok: true, caller: { userId: anna.id, scopes: ["tickets:read"] } });
  });

  it("createKeyAction refuses an unknown scope and a signed-out caller", async () => {
    const anna = await customer(auth, "Anna");
    await signedIn(anna);
    expect(await actions.createKeyAction("x", "admin" as never)).toMatchObject({ ok: false });
    wiring.cookie = "";
    expect(await actions.createKeyAction("x", "read")).toMatchObject({ ok: false });
    expect(await t.db.select().from(apikey).where(eq(apikey.name, "x"))).toEqual([]);
  });

  it.each([
    ["read", ["tickets:read"]],
    ["read-write", ["tickets:read", "tickets:write"]],
  ] as const)("rotate keeps the %s scope and kills the old key", async (scope, scopes) => {
    const anna = await customer(auth, "Anna");
    await signedIn(anna);
    const made = await actions.createKeyAction("Agent", scope);
    if (!made.ok) throw new Error(made.error);
    const [row] = await t.db.select().from(apikey).where(eq(apikey.name, "Agent"));

    const rotated = await actions.rotateKeyAction(row!.id);
    expect(rotated).toMatchObject({ ok: true, name: "Agent" });
    if (!rotated.ok) throw new Error(rotated.error);
    expect(rotated.key).not.toBe(made.key);

    const r = await resolveCaller({ auth, db: t.db }, toolCallRequest("my_orders", {}, bearer(rotated.key)));
    expect(r).toMatchObject({ ok: true, caller: { userId: anna.id, scopes } });
    const old = await call("my_orders", {}, bearer(made.key));
    expect(old.status).toBe(401);
  });

  it("another user cannot rotate (and so take over) Anna's key", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    await signedIn(anna);
    const made = await actions.createKeyAction("Agent", "read");
    if (!made.ok) throw new Error(made.error);
    const [row] = await t.db.select().from(apikey).where(eq(apikey.name, "Agent"));

    await signedIn(bela);
    expect(await actions.rotateKeyAction(row!.id)).toMatchObject({ ok: false });
    expect(await actions.revokeKeyAction(row!.id)).toHaveProperty("error");
    // Anna's key still works, and Bela got no key to her account.
    expect(toolResult(await call("my_orders", {}, bearer(made.key))).isError).toBe(false);
    const annas = await t.db.select().from(apikey).where(eq(apikey.referenceId, anna.id));
    expect(annas.map((k) => k.id)).toContain(row!.id);
  });
});

describe("search_docs (public)", () => {
  it("anonymous: the early-bird refund question returns the refund-policy section first, verbatim", async () => {
    const r = toolResult(await call("search_docs", { query: "how do refunds work for early-bird tickets?" }));
    expect(r.isError).toBe(false);
    const top = r.data.results[0];
    expect(top).toMatchObject({ section: "Refunds for early-bird tickets", source: "help/refund-policy.md", page: "Refund policy" });
    const file = fs.readFileSync(path.join(process.cwd(), "help/refund-policy.md"), "utf8");
    expect(file).toContain(top.text);
    expect(top.text).toContain("€44.10");
  });

  it("the policy's early-bird example is what refund_order actually pays", async () => {
    // €50.00 event 60 days out: early-bird 10% → €45.00 paid for the ticket; docs promise €44.10 back.
    const anna = await customer(auth, "Anna");
    const ev = await venue(t.db, { startsAtMs: Date.now() + 60 * DAY, createdAtMs: Date.now() - DAY });
    const one = await bookWith(anna.key, ev.id, 1);
    const r1 = toolResult(await call("refund_order", { order_id: one.order_id }, bearer(anna.key)));
    expect(r1.data.refunded_eur).toBe(44.1);
    // "How refunds work": 2 tickets, €90.00 + €2.70 service fee, refund €88.20.
    const two = await bookWith(anna.key, ev.id, 2);
    expect((await getOrder(t.db, two.order_id))!).toMatchObject({ ticketsCents: 9000, feeCents: 270, totalCents: 9270 });
    const r2 = toolResult(await call("refund_order", { order_id: two.order_id }, bearer(anna.key)));
    expect(r2.data.refunded_eur).toBe(88.2);
  });

  it("respects limit, and an unmatched query returns no results (not an error)", async () => {
    const r = toolResult(await call("search_docs", { query: "refund", limit: 1 }));
    expect(r.data.results).toHaveLength(1);
    const none = toolResult(await call("search_docs", { query: "zzqx plutonium" }));
    expect(none.isError).toBe(false);
    expect(none.data.results).toEqual([]);
  });
});

describe("cancel_event link", () => {
  it("an admin's read & write key gets /admin/events/<id>/cancel?via=mcp and nothing changes", async () => {
    const anna = await customer(auth, "Anna");
    const boss = await customer(auth, "Boss");
    await makeAdmin(t.db, boss.id);
    const ev = await upcoming(t.db);
    const booked = await bookWith(anna.key, ev.id, 2);

    const r = toolResult(await call("cancel_event", { event_id: ev.id }, bearer(boss.key)));
    expect(r.isError, r.text).toBe(false);
    expect(r.data.confirm_url).toBe(`http://localhost:3000/admin/events/${ev.id}/cancel?via=mcp`);
    expect(r.data.cancelled).toBe(false);
    expect((await getEvent(t.db, ev.id))!).toMatchObject({ cancelledAtMs: null, seatsSold: 42 });
    expect((await getOrder(t.db, booked.order_id))!.status).toBe("paid");
  });

  it("an event id with URL-special characters stays inside the path segment", async () => {
    const boss = await customer(auth, "Boss");
    await makeAdmin(t.db, boss.id);
    const ev = await upcoming(t.db, { id: "rock/../../settings?x=1#frag" });
    const r = toolResult(await call("cancel_event", { event_id: ev.id }, bearer(boss.key)));
    expect(r.isError, r.text).toBe(false);
    const url = new URL(r.data.confirm_url);
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname.startsWith("/admin/events/")).toBe(true);
    expect(url.pathname.endsWith("/cancel")).toBe(true);
    expect(url.searchParams.get("via")).toBe("mcp");
    expect([...url.searchParams.keys()]).toEqual(["via"]);
    expect(url.hash).toBe("");
  });
});
