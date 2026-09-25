// ADVERSARIAL: "who is calling?" (src/mcp/caller.ts) and the Settings →
// Developers key operations, against a real Better Auth over a real Postgres.
// Attacks: malformed Authorization headers, revoked / rotated / disabled /
// expired keys, banned owners, and one user managing another user's keys or
// connected apps through the same auth.api calls the server actions make.
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { createAuth, type Auth } from "../../src/auth/auth";
import { resolveCaller } from "../../src/mcp/caller";
import { apikey, oauthClient, oauthConsent, user } from "../../src/db/schema";
import { useTestDatabase } from "./database";

const t = useTestDatabase();
// Nothing listens here: any OAuth path that tries to fetch JWKS fails closed.
const BASE = "http://127.0.0.1:9";
let auth: Auth;

beforeAll(() => {
  auth = createAuth(t.db, { baseURL: BASE, secret: "adversarial-secret-adversarial-secret-0123" });
});

function req(authorization?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request(`${BASE}/api/mcp`, { method: "POST", headers, body: "{}" });
}
const resolve = (authorization?: string) => resolveCaller({ auth, db: t.db, baseURL: BASE }, req(authorization));

async function signUp(): Promise<{ id: string; headers: Headers }> {
  const email = `${randomUUID().slice(0, 10)}@example.com`;
  const r = await auth.api.signUpEmail({ body: { email, password: "password-123456", name: "Adv" }, returnHeaders: true });
  const cookie = (r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie") ?? ""]).map((c) => c.split(";")[0]).join("; ");
  const [row] = await t.db.select().from(user).where(eq(user.email, email));
  return { id: row.id, headers: new Headers({ cookie }) };
}

async function keyFor(u: { headers: Headers }, name = "agent"): Promise<{ id: string; key: string }> {
  const created = await auth.api.createApiKey({ body: { name }, headers: u.headers });
  return { id: created.id, key: created.key };
}

describe("ADVERSARIAL malformed Authorization headers never become anonymous or someone else", () => {
  it.each([
    ["Bearer", "scheme with no token"],
    ["Bearer    ", "scheme with blanks"],
    ["Basic dXNlcjpwYXNz", "basic auth"],
    ["tb_abcdefgh", "raw key with no scheme"],
    ["Token tb_abcdefgh", "wrong scheme"],
    ["Bearer tb_", "prefix only"],
    ["Bearer tb_doesnotexist0000000000", "unknown key"],
    ["Bearer TB_doesnotexist0000000000", "unknown key, upper-case prefix"],
    ["Bearer not-a-jwt", "garbage token"],
    ["Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.", "alg=none JWT"],
  ])("%s (%s) is refused, not treated as anonymous", async (h) => {
    const r = await resolve(h);
    expect(r.ok).toBe(false);
  });

  it("no header at all is anonymous", async () => {
    expect(await resolve()).toEqual({ ok: true, caller: null });
  });
});

describe("ADVERSARIAL API key lifecycle", () => {
  it("a valid key resolves to its owner, and only its owner", async () => {
    const a = await signUp();
    const b = await signUp();
    const k = await keyFor(a);
    const r = await resolve(`Bearer ${k.key}`);
    expect(r.ok && r.caller?.userId).toBe(a.id);
    expect(r.ok && r.caller?.userId).not.toBe(b.id);
    // an alternate casing of the scheme is fine, junk after the key is not
    expect((await resolve(`bearer ${k.key}`)).ok).toBe(true);
    expect((await resolve(`Bearer ${k.key} extra`)).ok).toBe(false);
    expect((await resolve(`Bearer ${k.key}x`)).ok).toBe(false);
  });

  it("a revoked key stops working at once", async () => {
    const a = await signUp();
    const k = await keyFor(a);
    expect((await resolve(`Bearer ${k.key}`)).ok).toBe(true);
    await auth.api.deleteApiKey({ body: { keyId: k.id }, headers: a.headers });
    expect((await resolve(`Bearer ${k.key}`)).ok).toBe(false);
  });

  it("rotation (create new + delete old, as rotateKeyAction does) kills the old secret", async () => {
    const a = await signUp();
    const old = await keyFor(a, "rotating");
    const fresh = await auth.api.createApiKey({ body: { name: "rotating" }, headers: a.headers });
    await auth.api.deleteApiKey({ body: { keyId: old.id }, headers: a.headers });
    expect((await resolve(`Bearer ${old.key}`)).ok).toBe(false);
    expect((await resolve(`Bearer ${fresh.key}`)).ok).toBe(true);
  });

  it("a disabled or expired key is refused", async () => {
    const a = await signUp();
    const k1 = await keyFor(a, "disabled");
    await t.db.update(apikey).set({ enabled: false }).where(eq(apikey.id, k1.id));
    expect((await resolve(`Bearer ${k1.key}`)).ok).toBe(false);
    const k2 = await keyFor(a, "expired");
    await t.db.update(apikey).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(apikey.id, k2.id));
    expect((await resolve(`Bearer ${k2.key}`)).ok).toBe(false);
  });

  it("a banned user's key is refused", async () => {
    const a = await signUp();
    const k = await keyFor(a);
    await t.db.update(user).set({ banned: true }).where(eq(user.id, a.id));
    expect((await resolve(`Bearer ${k.key}`)).ok).toBe(false);
  });

  it("a deleted user's key is refused", async () => {
    const a = await signUp();
    const k = await keyFor(a);
    await t.db.delete(user).where(eq(user.id, a.id));
    expect((await resolve(`Bearer ${k.key}`)).ok).toBe(false);
  });

  it("the role the tools see comes from the database at call time (demoting an admin takes effect at once)", async () => {
    const a = await signUp();
    await t.db.update(user).set({ role: "admin" }).where(eq(user.id, a.id));
    const k = await keyFor(a);
    const r1 = await resolve(`Bearer ${k.key}`);
    expect(r1.ok && r1.caller?.role).toBe("admin");
    await t.db.update(user).set({ role: "user" }).where(eq(user.id, a.id));
    const r2 = await resolve(`Bearer ${k.key}`);
    expect(r2.ok && r2.caller?.role).toBe("user");
  });
});

describe("ADVERSARIAL Settings → Developers: one user cannot touch another's keys or apps", () => {
  it("cannot read, revoke or 'rotate' someone else's key", async () => {
    const a = await signUp();
    const b = await signUp();
    const victim = await keyFor(a, "victim");

    // rotateKeyAction step 1 reads the key by id with the caller's session.
    await expect(auth.api.getApiKey({ query: { id: victim.id }, headers: b.headers })).rejects.toBeTruthy();
    // revokeKeyAction / rotate step 3 delete by id with the caller's session.
    await expect(auth.api.deleteApiKey({ body: { keyId: victim.id }, headers: b.headers })).rejects.toBeTruthy();
    expect((await resolve(`Bearer ${victim.key}`)).ok).toBe(true);

    // and listing shows only your own keys
    const list = (await auth.api.listApiKeys({ headers: b.headers })) as unknown;
    const ids = JSON.stringify(list);
    expect(ids).not.toContain(victim.id);
  });

  it("cannot disconnect someone else's connected app", async () => {
    const a = await signUp();
    const b = await signUp();
    const clientId = `client-${randomUUID().slice(0, 8)}`;
    await t.db.insert(oauthClient).values({
      id: randomUUID(), clientId, redirectUris: ["http://localhost/cb"], name: "Some app", createdAt: new Date(), updatedAt: new Date(),
    } as typeof oauthClient.$inferInsert);
    const consentId = randomUUID();
    await t.db.insert(oauthConsent).values({
      id: consentId, clientId, userId: a.id, scopes: ["tickets:read"], createdAt: new Date(), updatedAt: new Date(),
    });
    await auth.api.deleteOAuthConsent({ body: { id: consentId }, headers: b.headers }).catch(() => undefined);
    const still = await t.db.select().from(oauthConsent).where(eq(oauthConsent.id, consentId));
    expect(still).toHaveLength(1);
  });
});
