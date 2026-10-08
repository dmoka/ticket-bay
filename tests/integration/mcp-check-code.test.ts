// check_discount_code over MCP, against a real Postgres: the public tool that
// says whether a code works right now and how much it takes off. Its verdict
// must be the one checkout gives — quote_price refuses with the same reason,
// book_tickets spends the use that then flips the verdict — and the tool
// itself must never spend a use.
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { getCode } from "../../src/db/codes-repo";
import { user } from "../../src/db/schema";
import { createFakeStripe } from "../../src/payments";
import { createTicketBayServer, PUBLIC_TOOLS, type Caller } from "../../src/mcp/tools";
import { useTestDatabase } from "./database";
import { addCode, DAY, NOW, venue } from "./fixtures";

const t = useTestDatabase();
const BASE = "http://localhost:3000";
const payments = createFakeStripe("sk_test_check_code");
let clock = NOW;

/** The local server: anonymous, public tools only — exactly what mcp/server.ts serves. */
const local = createMcpHandler(() => createTicketBayServer({ db: t.db, payments, now: () => clock, baseURL: BASE }, null, { includePrivate: false }));
/** The remote server, for a customer who can book. */
const remote = createMcpHandler((ctx) => {
  const caller = (ctx.authInfo?.extra?.caller ?? null) as Caller;
  return createTicketBayServer({ db: t.db, payments, now: () => clock, baseURL: BASE }, caller, { includePrivate: true });
});

type Reply = { status: number; isError: boolean; text: string; data: any };

async function rpc(handler: typeof local, caller: Caller, body: unknown): Promise<{ status: number; body: any }> {
  const res = await handler.fetch(
    new Request(`${BASE}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify(body),
    }),
    { authInfo: caller ? { token: "", clientId: "api-key", scopes: caller.scopes, extra: { caller } } : undefined },
  );
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  let parsed: any = null;
  try {
    parsed = JSON.parse(dataLine ? dataLine.slice(6) : text);
  } catch {
    /* not json */
  }
  return { status: res.status, body: parsed };
}

async function call(handler: typeof local, caller: Caller, name: string, args: Record<string, unknown>): Promise<Reply> {
  const r = await rpc(handler, caller, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const text: string = r.body?.result?.content?.[0]?.text ?? r.body?.error?.message ?? "";
  const isError = r.status >= 400 || !!r.body?.error || r.body?.result?.isError === true;
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* an error message */
  }
  return { status: r.status, isError, text, data };
}

const check = (code: unknown) => call(local, null, "check_discount_code", { code });
const quoteWith = (eventId: string, code: string) => call(local, null, "quote_price", { event_id: eventId, quantity: 1, discount_code: code });

async function newUser(): Promise<NonNullable<Caller>> {
  const id = `u_${randomUUID().slice(0, 12)}`;
  await t.db.insert(user).values({ id, name: `User ${id}`, email: `${id}@example.com` });
  return { userId: id, email: `${id}@example.com`, name: `User ${id}`, role: null, scopes: ["tickets:read", "tickets:write"] };
}

describe("check_discount_code is a public tool", () => {
  it("is listed by the local (anonymous) server next to the other browsing tools", async () => {
    const r = await rpc(local, null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = r.body.result.tools.map((x: { name: string }) => x.name).sort();
    expect(names).toEqual([...PUBLIC_TOOLS].sort());
    expect(names).toContain("check_discount_code");
  });
});

describe("check_discount_code says whether a code works right now and how much it takes off", () => {
  it("a live code: valid, with its percent", async () => {
    clock = NOW;
    await addCode(t.db, "WELCOME10", 10);
    const r = await check("WELCOME10");
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ code: "WELCOME10", valid: true, percent_off: 10 });
    expect(r.data).not.toHaveProperty("reason");
  });

  it("is case-insensitive and ignores surrounding whitespace, like checkout", async () => {
    clock = NOW;
    await addCode(t.db, "WELCOME10", 10);
    for (const typed of ["welcome10", "Welcome10", "  WELCOME10  ", "\twelcome10\n"]) {
      const r = await check(typed);
      expect(r.isError, typed).toBe(false);
      expect(r.data, typed).toMatchObject({ code: "WELCOME10", valid: true, percent_off: 10 });
    }
  });

  it("an unknown code is a normal answer, not a tool error, and names no percent", async () => {
    clock = NOW;
    const r = await check("NOPE");
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toEqual({ code: "NOPE", valid: false, reason: "Unknown discount code." });
  });

  it.each([
    ["switched off", { active: false }, /no longer active/],
    ["used up", { maxUses: 3, uses: 3 }, /fully redeemed/],
    ["expired", { expiresAtMs: NOW - 1 }, /expired/],
  ])("a %s code: valid false with that reason", async (_label, over, reason) => {
    clock = NOW;
    await addCode(t.db, "DEAD", 25, over);
    const r = await check("DEAD");
    expect(r.isError, r.text).toBe(false);
    expect(r.data).toMatchObject({ code: "DEAD", valid: false });
    expect(r.data.reason).toMatch(reason);
    expect(r.data).not.toHaveProperty("percent_off");
  });

  it("a code stops working AT its expiry instant: valid one millisecond before, expired at it", async () => {
    const expiresAtMs = NOW + 3 * DAY;
    await addCode(t.db, "LASTCALL", 15, { expiresAtMs });

    clock = expiresAtMs - 1;
    expect((await check("LASTCALL")).data).toMatchObject({ valid: true, percent_off: 15 });

    clock = expiresAtMs;
    const at = (await check("LASTCALL")).data;
    expect(at).toMatchObject({ valid: false });
    expect(at.reason).toMatch(/expired/);
    clock = NOW;
  });

  it("a code with one use left is valid; it is used up right after someone books with it", async () => {
    clock = NOW;
    const ev = await venue(t.db);
    await addCode(t.db, "LASTONE", 20, { maxUses: 1, uses: 0 });
    expect((await check("LASTONE")).data).toMatchObject({ valid: true, percent_off: 20 });

    const buyer = await newUser();
    const booked = await call(remote, buyer, "book_tickets", { event_id: ev.id, quantity: 1, discount_code: "lastone" });
    expect(booked.isError, booked.text).toBe(false);

    const after = (await check("LASTONE")).data;
    expect(after).toMatchObject({ valid: false });
    expect(after.reason).toMatch(/fully redeemed/);
  });

  it("checking never spends a use", async () => {
    clock = NOW;
    await addCode(t.db, "ONCE", 5, { maxUses: 1, uses: 0 });
    for (let i = 0; i < 5; i++) expect((await check("ONCE")).data).toMatchObject({ valid: true, percent_off: 5 });
    expect((await getCode(t.db, "ONCE"))!.uses).toBe(0);
  });

  it.each([
    [{}, "no code"],
    [{ code: "" }, "empty code"],
    [{ code: "   " }, "blank code"],
    [{ code: "x".repeat(101) }, "101-char code"],
    [{ code: 10 }, "numeric code"],
    [{ code: ["WELCOME10"] }, "array code"],
    [{ code: { $ne: "" } }, "object code"],
  ])("rejects %j (%s) cleanly", async (args: unknown, _label: string) => {
    const r = await call(local, null, "check_discount_code", args as Record<string, unknown>);
    expect(r.isError).toBeTruthy();
    expect(r.status).toBeLessThan(500);
  });
});

describe("check_discount_code gives the same verdict as checkout", () => {
  it.each([
    ["live", {}],
    ["switched off", { active: false }],
    ["used up", { maxUses: 2, uses: 2 }],
    ["expired a day ago", { expiresAtMs: NOW - DAY }],
    ["expiring this instant", { expiresAtMs: NOW }],
    ["expiring in a day", { expiresAtMs: NOW + DAY }],
    ["one use left", { maxUses: 2, uses: 1 }],
  ])("a %s code: quote_price accepts exactly when the check says valid, and refuses with the same reason", async (_label, over) => {
    clock = NOW;
    const ev = await venue(t.db);
    await addCode(t.db, "SAME", 30, over);

    const verdict = (await check("same")).data;
    const quoted = await quoteWith(ev.id, "same");

    if (verdict.valid) {
      expect(quoted.isError, quoted.text).toBe(false);
      const discount = quoted.data.line_items.find((l: { label: string }) => l.label.startsWith("Discount"));
      expect(discount.label).toContain(`code SAME ${verdict.percent_off}%`);
    } else {
      expect(quoted.isError).toBe(true);
      expect(quoted.text).toBe(verdict.reason);
    }
  });

  it("an unknown code: quote_price refuses with the check's reason", async () => {
    clock = NOW;
    const ev = await venue(t.db);
    const verdict = (await check("GHOST")).data;
    const quoted = await quoteWith(ev.id, "GHOST");
    expect(verdict.valid).toBe(false);
    expect(quoted.isError).toBe(true);
    expect(quoted.text).toBe(verdict.reason);
  });
});
