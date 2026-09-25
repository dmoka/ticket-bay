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
        ? { token: "", clientId: caller.via, scopes: caller.scopes ?? [], resource: new URL(`${BASE}/api/mcp`), extra: { caller } }
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
  return { userId: id, email, name: `User ${id}`, role, via: "api-key", scopes: null };
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

describe("ADVERSARIAL OAuth scopes are enforced per tool", () => {
  it("a read-only OAuth grant cannot book (charge a card) or refund", async () => {
    clock = NOW;
    const ev = await venue(t.db);
    const u = await newUser();
    const readOnly: Caller = { ...u, via: "oauth", scopes: ["openid", "tickets:read"] };
    const book = await call(readOnly, "book_tickets", { event_id: ev.id, quantity: 1 });
    expect(book.status).toBe(403);
    expect(await orderCount()).toBe(0);

    const { order } = await placeOrder({ db: t.db, payments, nowMs: NOW }, {
      eventId: ev.id, quantity: 1, email: u.email, name: u.name, userId: u.userId, idempotencyKey: `seed-${randomUUID()}`,
    });
    const refund = await call(readOnly, "refund_order", { order_id: order.id });
    expect(refund.status).toBe(403);
    expect((await getOrder(t.db, order.id))!.status).toBe("paid");

    const list = await call(readOnly, "my_orders", {});
    expect(isToolError(list)).toBeFalsy();
  });

  it("an OAuth token with no scopes at all cannot read orders", async () => {
    const u = await newUser();
    const r = await call({ ...u, via: "oauth", scopes: [] }, "my_orders", {});
    expect(r.status).toBe(403);
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
    expect(url.searchParams.get("cancel")).toBe(ev.id);
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
