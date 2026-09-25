// Accounts, API keys and MCP calls for the Postgres integration lane. Real
// Better Auth over the test file's own database (createAuth), real keys, real
// sessions — nothing about auth or the database is stubbed.
import { beforeEach, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createAuth, KEY_SCOPES, type Auth, type KeyScope } from "../../src/auth/auth";
import type { Db } from "../../src/db/client";
import { apikey, user } from "../../src/db/schema";
import type { TestDatabase } from "./database";

export const BASE_URL = "http://localhost:3000";
export const SECRET = "integration-secret-integration-secret-0123";

export function makeAuth(db: Db): Auth {
  return createAuth(db, { baseURL: BASE_URL, secret: SECRET });
}

/**
 * Empties the account tables before every test (database.ts only empties
 * orders, codes and events). Register AFTER useTestDatabase().
 */
export function useCleanAccounts(t: TestDatabase) {
  beforeEach(async () => {
    await t.db.execute(sql`TRUNCATE "user", "session", "account", "verification", "apikey" RESTART IDENTITY CASCADE`);
  });
}

export interface Customer {
  id: string;
  email: string;
  name: string;
  /** "better-auth.session_token=…" — a signed-in browser's cookie */
  cookie: string;
  /** a fresh tb_ key owned by this customer */
  key: string;
  keyId: string;
}

let n = 0;

/** Sign up through Better Auth and create one API key, as Settings → Developers does. */
export async function customer(auth: Auth, name = `Customer ${++n}`): Promise<Customer> {
  const email = `${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, ".")}.${++n}@example.com`;
  const su = await auth.api.signUpEmail({ body: { email, password: "correct-horse-battery", name }, returnHeaders: true });
  const cookie = su.headers.get("set-cookie")!.split(";")[0]!;
  const key = await auth.api.createApiKey({ body: { name: "agent" }, headers: new Headers({ cookie }) });
  expect(key.key.startsWith("tb_")).toBe(true);
  return { id: su.response.user.id, email, name, cookie, key: key.key, keyId: key.id };
}

/**
 * A key with an explicit scope, made the way Settings → Developers makes it:
 * Better Auth's server-only path (no session headers, the user id in the body).
 */
export async function scopedKey(auth: Auth, userId: string, scope: KeyScope, name = "agent"): Promise<{ key: string; keyId: string }> {
  const created = await auth.api.createApiKey({ body: { name, userId, permissions: { tickets: [...KEY_SCOPES[scope].tickets] } } });
  expect(created.key.startsWith("tb_")).toBe(true);
  return { key: created.key, keyId: created.id };
}

/** Revoke a key the way the Settings page does: the owner deletes it. */
export async function revokeKey(auth: Auth, c: Customer) {
  const r = await auth.api.deleteApiKey({ body: { keyId: c.keyId }, headers: new Headers({ cookie: c.cookie }) });
  expect(r).toEqual({ success: true });
}

export async function makeAdmin(db: Db, userId: string) {
  await db.update(user).set({ role: "admin" }).where(eq(user.id, userId));
}

export async function ban(db: Db, userId: string) {
  await db.update(user).set({ banned: true }).where(eq(user.id, userId));
}

export async function expireKey(db: Db, keyId: string) {
  await db.update(apikey).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(apikey.id, keyId));
}

// ---- JSON-RPC over the route --------------------------------------------------

export interface RpcReply {
  status: number;
  wwwAuthenticate: string | null;
  /** the JSON-RPC message(s) in the body */
  body: unknown;
}

/** The body of a Streamable HTTP reply: plain JSON, or the `data:` lines of an SSE stream. */
export async function readReply(res: Response): Promise<RpcReply> {
  const text = await res.text();
  let body: unknown = null;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const msgs = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => JSON.parse(l.slice(5)));
    body = msgs.length === 1 ? msgs[0] : msgs;
  } else if (text) {
    body = JSON.parse(text);
  }
  return { status: res.status, wwwAuthenticate: res.headers.get("www-authenticate"), body };
}

let rpcId = 0;

export function toolCallRequest(name: string, args: object = {}, headers: Record<string, string> = {}, id = ++rpcId): Request {
  return rpcRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, headers);
}

export function rpcRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE_URL}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

export interface ToolOutcome {
  isError: boolean;
  text: string;
  /** parsed JSON when the tool answered with JSON */
  data: any;
}

/** The tool result inside a successful JSON-RPC reply. Fails the test on a transport-level error. */
export function toolResult(reply: RpcReply): ToolOutcome {
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  const msg = reply.body as { result?: { content: { type: string; text: string }[]; isError?: boolean }; error?: unknown };
  expect(msg.error, JSON.stringify(msg.error)).toBeUndefined();
  const text = msg.result!.content.map((c) => c.text).join("\n");
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    // plain-text tool error
  }
  return { isError: msg.result!.isError === true, text, data };
}
