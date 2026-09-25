// ADVERSARIAL: the remote MCP tools, driven over real Streamable HTTP through
// createMcpHandler exactly as app/api/mcp/route.ts wires them (caller in
// authInfo.extra, resource set), against a real Postgres. Attacks: anonymous
// and wrong-scope access to private tools, cross-user orders/refunds,
// non-admin cancel_event, deep links for events that must not be cancelled.
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { getOrder } from "../../src/db/orders-repo";
import { user } from "../../src/db/schema";
import { createFakeStripe } from "../../src/payments";
import { createTicketBayServer, type Caller } from "../../src/mcp/tools";
import { placeOrder } from "../../src/services/orders";
import { useTestDatabase } from "./database";
import { DAY, NOW, venue } from "./fixtures";

const t = useTestDatabase();
const BASE = "http://localhost:3000";
const payments = createFakeStripe("sk_test_adv_mcp");
let clock = NOW;

const handler = createMcpHandler((ctx) => {
  const caller = (ctx.authInfo?.extra?.caller ?? null) as Caller;
  return createTicketBayServer({ db: t.db, payments, now: () => clock, baseURL: BASE }, caller, { includePrivate: true });
});

type Reply = { status: number; body: any; text: string };

async function rpc(caller: Caller, body: unknown): Promise<Reply> {
  const res = await handler.fetch(
    new Request(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify(body),
    }),
    {
      authInfo: caller
        ? { token: "", clientId: "api-key", scopes: caller.scopes, extra: { caller } }
        : undefined,
    },
  );
  const text = await res.text();
  let parsed: any = null;
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  try {
    parsed = JSON.parse(dataLine ? dataLine.slice(6) : text);
  } catch {
    /* not json */
  }
  return { status: res.status, body: parsed, text };
}

const call = (caller: Caller, name: string, args: Record<string, unknown>) =>
  rpc(caller, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

function toolText(r: Reply): string {
  return r.body?.result?.content?.[0]?.text ?? r.body?.error?.message ?? r.text;
}
const isToolError = (r: Reply) => r.status >= 400 || r.body?.error || r.body?.result?.isError === true;

async function newUser(role: string | null = null): Promise<NonNullable<Caller>> {
  const id = `u_${randomUUID().slice(0, 12)}`;
  const email = `${id}@example.com`;
  await t.db.insert(user).values({ id, name: `User ${id}`, email, role });
  return { userId: id, email, name: `User ${id}`, role, scopes: ["tickets:read", "tickets:write"] };
}

async function orderCount(): Promise<number> {
  const r = await t.db.execute(sql`SELECT count(*)::int AS n FROM orders`);
  return (r.rows[0] as { n: number }).n;
}

describe("ADVERSARIAL anonymous callers never reach a private tool", () => {
  it.each(["book_tickets", "my_orders", "refund_order", "cancel_event"])("%s refuses an anonymous caller and changes nothing", async (tool) => {
    clock = NOW;
    const ev = await venue(t.db);
    const args = { book_tickets: { event_id: ev.id, quantity: 1 }, my_orders: {}, refund_order: { order_id: 1 }, cancel_event: { event_id: ev.id } }[tool]!;
    const r = await call(null, tool, args);
    expect(isToolError(r)).toBeTruthy();
    expect(toolText(r)).toMatch(/401|unauthori[sz]ed/i);
    expect(await orderCount()).toBe(0);
  });

  it("case / whitespace variants of a private tool name do not slip through", async () => {
    const ev = await venue(t.db);
    for (const name of ["Book_Tickets", "BOOK_TICKETS", " book_tickets", "book_tickets ", "book-tickets"]) {
      const r = await call(null, name, { event_id: ev.id, quantity: 1 });
      expect(isToolError(r), name).toBeTruthy();
    }
    expect(await orderCount()).toBe(0);
  });
});

// Spec (scope change): MCP OAuth is gone; API keys carry scopes. A read-only
// key ({tickets:["read"]}) may call my_orders; book_tickets, refund_order and
// cancel_event need tickets:write and answer with a 403-style TOOL error.
describe("ADVERSARIAL key scopes are enforced per tool", () => {
  const forbidden = (r: Reply) => isToolError(r) && /403|forbidden/i.test(toolText(r));

  it("a read-only key cannot book (charge a card) or refund, even by replaying an existing order's key", async () => {
    clock = NOW;
    const ev = await venue(t.db);
    const u = await newUser();
    const readOnly: Caller = { ...u, scopes: ["tickets:read"] };
    const book = await call(readOnly, "book_tickets", { event_id: ev.id, quantity: 1 });
    expect(forbidden(book), toolText(book)).toBe(true);
    expect(await orderCount()).toBe(0);

    // The same customer booked earlier with a read & write key...
    const booked = await call(u, "book_tickets", { event_id: ev.id, quantity: 1, idempotency_key: "rw-1" });
    const orderId = JSON.parse(toolText(booked)).order_id as number;
    // ...a read-only key replaying that idempotency key gets nothing back.
    const replay = await call(readOnly, "book_tickets", { event_id: ev.id, quantity: 1, idempotency_key: "rw-1" });
    expect(forbidden(replay), toolText(replay)).toBe(true);
    expect(toolText(replay)).not.toContain(String(orderId).padStart(5, "0"));

    const refund = await call(readOnly, "refund_order", { order_id: orderId });
    expect(forbidden(refund), toolText(refund)).toBe(true);
    expect((await getOrder(t.db, orderId))!.status).toBe("paid");
    expect(await orderCount()).toBe(1);

    const list = await call(readOnly, "my_orders", {});
    expect(isToolError(list)).toBeFalsy();
  });

  it("a read-only ADMIN key cannot get a cancel link", async () => {
    clock = NOW;
    const ev = await venue(t.db);
    const admin = await newUser("admin");
    const r = await call({ ...admin, scopes: ["tickets:read"] }, "cancel_event", { event_id: ev.id });
    expect(forbidden(r), toolText(r)).toBe(true);
    expect(toolText(r)).not.toContain("/cancel");
  });

  it.each([
    [[], "no scopes"],
    [["tickets:write"], "write without read"],
    [["Tickets:Read", "TICKETS:WRITE"], "wrong case"],
    [["tickets:read ", " tickets:write"], "padded"],
    [["tickets:*"], "wildcard"],
    [["tickets:read,write"], "comma-joined"],
  ])("scopes %j (%s) never unlock a scope they do not name exactly", async (scopes, _label) => {
    clock = NOW;
    const ev = await venue(t.db);
    const u = await newUser();
    const c: Caller = { ...u, scopes: scopes as string[] };
    const book = await call(c, "book_tickets", { event_id: ev.id, quantity: 1 });
    if (!(scopes as string[]).includes("tickets:write")) expect(isToolError(book), toolText(book)).toBeTruthy();
    const list = await call(c, "my_orders", {});
    if (!(scopes as string[]).includes("tickets:read")) expect(isToolError(list), toolText(list)).toBeTruthy();
    if (!(scopes as string[]).includes("tickets:write")) expect(await orderCount()).toBe(0);
  });

  it("a JSON-RPC batch mixing a read and a write call with a read-only key writes nothing", async () => {
    clock = NOW;
    const ev = await venue(t.db);
    const u = await newUser();
    const r = await rpc({ ...u, scopes: ["tickets:read"] }, [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "my_orders", arguments: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "book_tickets", arguments: { event_id: ev.id, quantity: 1 } } },
    ]);
    expect(r.status).toBeLessThan(500);
    expect(await orderCount()).toBe(0);
  });
});

describe("ADVERSARIAL cross-user access through the tools", () => {
  it("my_orders shows only the caller's orders; refund_order on someone else's order is 'not found' and moves no money", async () => {
    clock = NOW;
    const ev = await venue(t.db);
    const alice = await newUser();
    const bob = await newUser();
    const booked = await call(alice, "book_tickets", { event_id: ev.id, quantity: 2, idempotency_key: "same-key" });
    expect(isToolError(booked)).toBeFalsy();
    const aliceOrder = JSON.parse(toolText(booked)).order_id as number;

    // Bob reuses Alice's idempotency key: must get his OWN new order, not hers.
    const bobBook = await call(bob, "book_tickets", { event_id: ev.id, quantity: 1, idempotency_key: "same-key" });
    const bobResult = JSON.parse(toolText(bobBook));
    expect(bobResult.replayed).toBe(false);
    expect(bobResult.order_id).not.toBe(aliceOrder);

    const bobsView = JSON.parse(toolText(await call(bob, "my_orders", {})));
    expect(bobsView.orders.map((o: { order_id: number }) => o.order_id)).toEqual([bobResult.order_id]);

    for (const id of [aliceOrder, `TB-${String(aliceOrder).padStart(5, "0")}`, `tb-${aliceOrder}`, `TB-000000000${aliceOrder}`]) {
      const r = await call(bob, "refund_order", { order_id: id });
      expect(isToolError(r), String(id)).toBeTruthy();
      expect(toolText(r)).toMatch(/not found/i);
    }
    expect((await getOrder(t.db, aliceOrder))!.status).toBe("paid");
  });

  it("refund_order rejects junk ids without crashing", async () => {
    const u = await newUser();
    for (const id of [0, -1, 1.5, "1e3", "TB-", "", "0x10", "99999999999999999999"]) {
      const r = await call(u, "refund_order", { order_id: id });
      expect(isToolError(r), String(id)).toBeTruthy();
      expect(r.status, String(id)).toBeLessThan(500);
    }
  });

  it("book_tickets cannot book a cancelled or past event", async () => {
    const u = await newUser();
    const past = await venue(t.db, { startsAtMs: NOW - DAY });
    const cancelled = await venue(t.db, { cancelledAtMs: NOW - DAY });
    clock = NOW;
    for (const ev of [past, cancelled]) {
      const r = await call(u, "book_tickets", { event_id: ev.id, quantity: 1 });
      expect(isToolError(r), ev.id).toBeTruthy();
    }
    expect(await orderCount()).toBe(0);
  });
});

describe("ADVERSARIAL cancel_event is admin-only and only for events that can be cancelled", () => {
  it("a customer (any role spelling that is not exactly admin) gets 403 and no confirm link", async () => {
    const ev = await venue(t.db);
    for (const role of [null, "user", "Admin", "ADMIN", " admin", "admin,user"]) {
      const u = await newUser(role);
      const r = await call(u, "cancel_event", { event_id: ev.id });
      expect(isToolError(r), String(role)).toBeTruthy();
      expect(toolText(r)).not.toContain("/admin/events");
    }
  });

  it("an admin gets a confirm link that changes nothing by itself", async () => {
    clock = NOW;
    const ev = await venue(t.db);
    const admin = await newUser("admin");
    const r = await call(admin, "cancel_event", { event_id: ev.id });
    const out = JSON.parse(toolText(r));
    expect(out.cancelled).toBe(false);
    const url = new URL(out.confirm_url);
    expect(url.origin).toBe(BASE);
    // Spec (scope change): the link is the event's own cancel page.
    expect(url.pathname).toBe(`/admin/events/${encodeURIComponent(ev.id)}/cancel`);
    expect(url.searchParams.get("via")).toBe("mcp");
    const row = await t.db.execute(sql`SELECT cancelled_at_ms FROM events WHERE id = ${ev.id}`);
    expect((row.rows[0] as { cancelled_at_ms: unknown }).cancelled_at_ms).toBeNull();
  });

  it("does not hand an admin a confirm link for an event that already took place", async () => {
    const ev = await venue(t.db);
    const admin = await newUser("admin");
    clock = ev.startsAtMs + DAY;
    const r = await call(admin, "cancel_event", { event_id: ev.id });
    clock = NOW;
    expect(isToolError(r)).toBeTruthy();
    expect(toolText(r)).not.toContain("confirm_url");
  });
});

describe("ADVERSARIAL search_docs over MCP (public, anonymous)", () => {
  it("works anonymously and only quotes help/*.md", async () => {
    const r = await call(null, "search_docs", { query: "../../.env secret refund" });
    expect(isToolError(r)).toBeFalsy();
    for (const hit of JSON.parse(toolText(r)).results) expect(hit.source).toMatch(/^help\/[a-z0-9-]+\.md$/);
  });

  it.each([
    [{ query: "a" }, "1-char query"],
    [{ query: "x".repeat(201) }, "201-char query"],
    [{ query: "refund", limit: 0 }, "limit 0"],
    [{ query: "refund", limit: -1 }, "limit -1"],
    [{ query: "refund", limit: 6 }, "limit 6"],
    [{ query: "refund", limit: 2.5 }, "fractional limit"],
    [{ query: ["refund"] }, "array query"],
    [{ query: { $ne: "" } }, "object query"],
  ])("rejects %j (%s) cleanly", async (args) => {
    const r = await call(null, "search_docs", args as Record<string, unknown>);
    expect(isToolError(r)).toBeTruthy();
    expect(r.status).toBeLessThan(500);
  });
});
