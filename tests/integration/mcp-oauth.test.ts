// The OAuth ("Connect") path of the remote MCP endpoint, for real: Better Auth
// runs behind a small local HTTP server (so its JWKS is reachable at
// `${baseURL}/api/auth/jwks`, exactly where src/mcp/caller.ts looks), a test
// client goes through the actual authorization-code + PKCE flow — create
// client, authorize with a signed-in session, consent, token exchange — and
// the resulting JWT is sent to the route's POST. Real Postgres
// (Testcontainers) underneath; only the route's process-wide singletons
// (getAuth / getDb / getPayments / appBaseURL) are pointed at this file's
// instances.
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { and, count, eq } from "drizzle-orm";
import { createAuth, type Auth } from "../../src/auth/auth";
import type { Db } from "../../src/db/client";
import { getEvent } from "../../src/db/events-repo";
import { getOrder } from "../../src/db/orders-repo";
import { oauthConsent, orders } from "../../src/db/schema";
import { resolveCaller } from "../../src/mcp/caller";
import { createFakeStripe } from "../../src/payments";
import { useTestDatabase } from "./database";
import { DAY, venue } from "./fixtures";
import { ban, bearer, customer, readReply, SECRET, toolCallRequest, toolResult, useCleanAccounts, type Customer } from "./accounts";

const wiring = vi.hoisted(() => ({ auth: undefined as unknown, db: undefined as unknown, payments: undefined as unknown, baseURL: "" }));
vi.mock("@/lib/auth", () => ({ appBaseURL: () => wiring.baseURL, getAuth: () => wiring.auth }));
vi.mock("@/src/db/client", () => ({ getDb: () => wiring.db }));
vi.mock("@/src/payments", async () => ({ ...(await import("../../src/payments")), getPayments: () => wiring.payments }));
vi.mock("@/src/mcp/caller", () => import("../../src/mcp/caller"));
vi.mock("@/src/mcp/tools", () => import("../../src/mcp/tools"));
vi.mock("@/src/auth/auth", () => import("../../src/auth/auth"));

const t = useTestDatabase();
useCleanAccounts(t);

let server: Server;
let base: string;
let auth: Auth;
let POST: (r: Request) => Promise<Response>;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(`${base}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    const out = await auth.handler(request);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  auth = createAuth(t.db, { baseURL: base, secret: SECRET });
  wiring.auth = auth;
  wiring.db = t.db;
  wiring.payments = createFakeStripe("sk_test_integration");
  wiring.baseURL = base;
  ({ POST } = await import("../../app/api/mcp/route"));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const REDIRECT = "http://127.0.0.1:9/callback";

interface Connected {
  token: string;
  clientId: string;
  claims: Record<string, unknown>;
}

async function json(res: Response) {
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBeLessThan(300);
  return body as Record<string, any>;
}

/** The whole Connect flow for one customer: client → authorize → consent → token. */
async function connect(c: Customer, scope: string, { resource = true }: { resource?: boolean } = {}): Promise<Connected> {
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base, ...extra }, body: JSON.stringify(body) });

  const client = await json(
    await post(
      "/api/auth/oauth2/create-client",
      {
        redirect_uris: [REDIRECT],
        client_name: "Test agent",
        token_endpoint_auth_method: "none",
        application_type: "native",
        scope: "openid tickets:read tickets:write",
      },
      { cookie: c.cookie },
    ),
  );
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    scope,
    state: "st",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...(resource ? { resource: `${base}/api/mcp` } : {}),
  });
  const authorize = await json(await fetch(`${base}/api/auth/oauth2/authorize?${q}`, { headers: { cookie: c.cookie }, redirect: "manual" }));
  const consentPage = new URL(authorize.url, base);
  expect(consentPage.pathname).toBe("/consent");
  const consent = await json(await post("/api/auth/oauth2/consent", { accept: true, oauth_query: consentPage.search.slice(1) }, { cookie: c.cookie }));
  const code = new URL(consent.url ?? consent.redirect_uri).searchParams.get("code")!;
  const token = await json(
    await fetch(`${base}/api/auth/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
        code_verifier: verifier,
        ...(resource ? { resource: `${base}/api/mcp` } : {}),
      }),
    }),
  );
  const parts = String(token.access_token).split(".");
  const claims = parts.length === 3 ? JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) : {};
  return { token: token.access_token, clientId: client.client_id, claims };
}

const call = async (name: string, args: object, headers: Record<string, string>) =>
  readReply(await POST(toolCallRequest(name, args, headers)));

const upcoming = (db: Db) => venue(db, { startsAtMs: Date.now() + 10 * DAY, createdAtMs: Date.now() - 30 * DAY });

async function orderCount(db: Db) {
  const [row] = await db.select({ n: count() }).from(orders);
  return row!.n;
}

describe("an OAuth access token resolves to the user who connected", () => {
  it("the JWT is issued for the MCP resource and maps to exactly its owner with its scopes", async () => {
    const anna = await customer(auth, "Anna");
    await customer(auth, "Bela");
    const conn = await connect(anna, "openid tickets:read tickets:write");
    expect(conn.claims).toMatchObject({ sub: anna.id, iss: `${base}/api/auth` });
    expect(conn.claims.aud).toContain(`${base}/api/mcp`);

    const r = await resolveCaller({ auth, db: t.db, baseURL: base }, new Request(`${base}/api/mcp`, { headers: bearer(conn.token) }));
    expect(r).toEqual({
      ok: true,
      caller: { userId: anna.id, email: anna.email, name: "Anna", role: "user", via: "oauth", scopes: ["openid", "tickets:read", "tickets:write"] },
    });
  });

  it("with tickets:read + tickets:write the customer can book, list and refund their own order over the route", async () => {
    const anna = await customer(auth, "Anna");
    const conn = await connect(anna, "openid tickets:read tickets:write");
    const ev = await upcoming(t.db);

    const booked = toolResult(await call("book_tickets", { event_id: ev.id, quantity: 2 }, bearer(conn.token)));
    expect(booked.isError, booked.text).toBe(false);
    expect((await getOrder(t.db, booked.data.order_id))!.userId).toBe(anna.id);

    const mine = toolResult(await call("my_orders", {}, bearer(conn.token)));
    expect(mine.data).toMatchObject({ customer: anna.email, count: 1 });

    const refund = toolResult(await call("refund_order", { order_id: booked.data.order_id }, bearer(conn.token)));
    expect(refund.isError, refund.text).toBe(false);
    expect((await getOrder(t.db, booked.data.order_id))!.status).toBe("refunded");
  });

  it("B's OAuth token cannot see or refund A's order", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    const a = await connect(anna, "openid tickets:read tickets:write");
    const b = await connect(bela, "openid tickets:read tickets:write");
    const ev = await upcoming(t.db);
    const booked = toolResult(await call("book_tickets", { event_id: ev.id, quantity: 1 }, bearer(a.token)));

    expect(toolResult(await call("my_orders", {}, bearer(b.token))).data).toMatchObject({ customer: bela.email, count: 0 });
    const r = toolResult(await call("refund_order", { order_id: booked.data.order_id }, bearer(b.token)));
    expect(r).toMatchObject({ isError: true, text: "Order not found." });
    expect((await getOrder(t.db, booked.data.order_id))!.status).toBe("paid");
  });
});

describe("OAuth scopes limit what a token can do", () => {
  it("a read-only token lists orders but cannot book or refund; nothing changes", async () => {
    const anna = await customer(auth, "Anna");
    const full = await connect(anna, "openid tickets:read tickets:write");
    const readOnly = await connect(anna, "openid tickets:read");
    expect(readOnly.claims.scope).toBe("openid tickets:read");
    const ev = await upcoming(t.db);
    const booked = toolResult(await call("book_tickets", { event_id: ev.id, quantity: 2 }, bearer(full.token)));

    expect(toolResult(await call("my_orders", {}, bearer(readOnly.token))).data.count).toBe(1);

    for (const [tool, args] of [
      ["book_tickets", { event_id: ev.id, quantity: 1 }],
      ["refund_order", { order_id: booked.data.order_id }],
    ] as const) {
      const reply = await call(tool, args, bearer(readOnly.token));
      expect(reply.status, `${tool}: ${JSON.stringify(reply.body)}`).toBe(403);
      expect(reply.wwwAuthenticate).toContain('error="insufficient_scope"');
      expect(reply.wwwAuthenticate).toContain('scope="tickets:write"');
      expect(reply.body).toMatchObject({ error: "insufficient_scope" });
    }
    expect(await orderCount(t.db)).toBe(1);
    expect((await getOrder(t.db, booked.data.order_id))!.status).toBe("paid");
    expect((await getEvent(t.db, ev.id))!.seatsSold).toBe(42);
  });

  it("a token without tickets:read cannot list orders", async () => {
    const anna = await customer(auth, "Anna");
    const idOnly = await connect(anna, "openid");
    const reply = await call("my_orders", {}, bearer(idOnly.token));
    expect(reply.status, JSON.stringify(reply.body)).toBe(403);
    expect(reply.wwwAuthenticate).toContain('scope="tickets:read"');
    expect(JSON.stringify(reply.body)).not.toContain(anna.email);
  });
});

describe("a bad or withdrawn OAuth token is refused — never anonymous", () => {
  const expectRefused = async (token: string, msg: RegExp) => {
    const r = await resolveCaller({ auth, db: t.db, baseURL: base }, new Request(`${base}/api/mcp`, { headers: bearer(token) }));
    expect(r.ok).toBe(false);
    for (const tool of ["list_events", "my_orders"]) {
      const reply = await call(tool, {}, bearer(token));
      expect(reply.status, `${tool} ${JSON.stringify(reply.body)}`).toBe(401);
      expect(reply.wwwAuthenticate).toContain('error="invalid_token"');
      expect((reply.body as { error: { message: string } }).error.message).toMatch(msg);
    }
  };

  it("after Disconnect (the consent is deleted) the still-unexpired JWT stops working", async () => {
    const anna = await customer(auth, "Anna");
    const conn = await connect(anna, "openid tickets:read tickets:write");
    expect(toolResult(await call("my_orders", {}, bearer(conn.token))).isError).toBe(false);

    const [grant] = await t.db
      .select({ id: oauthConsent.id })
      .from(oauthConsent)
      .where(and(eq(oauthConsent.userId, anna.id), eq(oauthConsent.clientId, conn.clientId)));
    expect(grant).toBeDefined();
    await auth.api.deleteOAuthConsent({ body: { id: grant!.id }, headers: new Headers({ cookie: anna.cookie }) });

    await expectRefused(conn.token, /disconnected/);
  });

  it("another user cannot disconnect Anna's app", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    const conn = await connect(anna, "openid tickets:read");
    const [grant] = await t.db.select({ id: oauthConsent.id }).from(oauthConsent).where(eq(oauthConsent.userId, anna.id));
    await auth.api.deleteOAuthConsent({ body: { id: grant!.id }, headers: new Headers({ cookie: bela.cookie }) }).catch(() => undefined);
    expect(toolResult(await call("my_orders", {}, bearer(conn.token))).isError).toBe(false);
  });

  it("a tampered JWT (payload changed to another user) is refused", async () => {
    const anna = await customer(auth, "Anna");
    const bela = await customer(auth, "Bela");
    const conn = await connect(anna, "openid tickets:read tickets:write");
    const [h, , s] = conn.token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...conn.claims, sub: bela.id })).toString("base64url");
    await expectRefused(`${h}.${forged}.${s}`, /invalid or expired/);
  });

  it("a token issued without the MCP resource (not for this audience) is refused", async () => {
    const anna = await customer(auth, "Anna");
    const conn = await connect(anna, "openid tickets:read", { resource: false });
    await expectRefused(conn.token, /invalid or expired/);
  });

  it("a token from another issuer's keys is refused", async () => {
    const anna = await customer(auth, "Anna");
    const conn = await connect(anna, "openid tickets:read");
    // Same token, but the server claims to live elsewhere: issuer and JWKS no longer match.
    const r = await resolveCaller({ auth, db: t.db, baseURL: "http://127.0.0.1:1" }, new Request(`${base}/api/mcp`, { headers: bearer(conn.token) }));
    expect(r.ok).toBe(false);
  });

  it("a token whose owner has been banned is refused", async () => {
    const anna = await customer(auth, "Anna");
    const conn = await connect(anna, "openid tickets:read");
    await ban(t.db, anna.id);
    await expectRefused(conn.token, /not active/);
  });
});
