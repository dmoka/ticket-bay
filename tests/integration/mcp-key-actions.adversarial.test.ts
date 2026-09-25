// ADVERSARIAL: the REAL Settings → Developers server actions (createKeyAction,
// rotateKeyAction, revokeKeyAction) against a real Better Auth over real
// Postgres. Only Next's request-scoped singletons are pointed at this file's
// instances (headers() carries the signed-in browser's cookie, getSession
// reads it), the same wiring as tests/integration/mcp-key-scopes.test.ts.
// Attacks: scope values that are not real scopes, another user's key id,
// signed-out calls, legacy keys without stored permissions.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import type { Auth } from "../../src/auth/auth";
import { apikey } from "../../src/db/schema";
import { resolveCaller } from "../../src/mcp/caller";
import { useTestDatabase } from "./database";
import { customer, makeAuth, scopedKey, useCleanAccounts } from "./accounts";

const wiring = vi.hoisted(() => ({ auth: undefined as any, cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(wiring.cookie ? { cookie: wiring.cookie } : {}) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth", () => ({
  appBaseURL: () => "http://localhost:3000",
  getAuth: () => wiring.auth,
  getSession: () => wiring.auth.api.getSession({ headers: new Headers(wiring.cookie ? { cookie: wiring.cookie } : {}) }),
}));
vi.mock("@/src/auth/auth", () => import("../../src/auth/auth"));

const t = useTestDatabase();
useCleanAccounts(t);

let auth: Auth;
let actions: typeof import("../../app/(public)/settings/developers/actions");

beforeAll(async () => {
  auth = makeAuth(t.db);
  wiring.auth = auth;
  actions = await import("../../app/(public)/settings/developers/actions");
});

const resolve = (key: string) =>
  resolveCaller({ auth, db: t.db }, new Request("http://localhost:3000/api/mcp", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: "{}" }));

async function keysOf(userId: string) {
  return t.db.select().from(apikey).where(eq(apikey.referenceId, userId));
}

describe("ADVERSARIAL createKeyAction trusts nothing from the client", () => {
  it.each(["toString", "__proto__", "constructor", "hasOwnProperty", "admin", "write", "READ", "read-write ", "", "read,read-write"])(
    "scope %j is refused and no key is created",
    async (scope) => {
      const anna = await customer(auth, "Anna");
      wiring.cookie = anna.cookie;
      const before = (await keysOf(anna.id)).length;
      const r = await actions.createKeyAction("evil", scope as never);
      expect(r.ok).toBe(false);
      expect((await keysOf(anna.id)).length).toBe(before);
    },
  );

  it("a signed-out call creates nothing", async () => {
    wiring.cookie = "";
    const r = await actions.createKeyAction("ghost", "read-write");
    expect(r.ok).toBe(false);
    expect((await t.db.select().from(apikey).where(eq(apikey.name, "ghost"))).length).toBe(0);
  });

  it("a forged session cookie creates nothing", async () => {
    wiring.cookie = "better-auth.session_token=forged.forged";
    const r = await actions.createKeyAction("forged", "read-write");
    expect(r.ok).toBe(false);
  });

  it("a read key made by the action is read-only; a read & write key is read & write — owned by the signed-in user", async () => {
    const anna = await customer(auth, "Anna");
    wiring.cookie = anna.cookie;
    const ro = await actions.createKeyAction("ro", "read");
    const rw = await actions.createKeyAction("rw", "read-write");
    if (!ro.ok || !rw.ok) throw new Error("expected keys");
    const a = await resolve(ro.key);
    const b = await resolve(rw.key);
    expect(a.ok && a.caller).toMatchObject({ userId: anna.id, scopes: ["tickets:read"] });
    expect(b.ok && [...b.caller!.scopes].sort()).toEqual(["tickets:read", "tickets:write"]);
  });
});

describe("ADVERSARIAL rotateKeyAction", () => {
  it("rotating a key with no stored permissions gives a working read & write key (catch E)", async () => {
    const anna = await customer(auth, "Anna");
    await t.db.update(apikey).set({ permissions: null }).where(eq(apikey.id, anna.keyId));
    wiring.cookie = anna.cookie;
    const r = await actions.rotateKeyAction(anna.keyId);
    if (!r.ok) throw new Error(r.error);
    const who = await resolve(r.key);
    expect(who.ok && who.caller!.userId).toBe(anna.id);
    expect(who.ok && [...who.caller!.scopes].sort()).toEqual(["tickets:read", "tickets:write"]);
    expect((await resolve(anna.key)).ok).toBe(false);
  });

  it("rotating a read-only key never widens it", async () => {
    const anna = await customer(auth, "Anna");
    const ro = await scopedKey(auth, anna.id, "read");
    wiring.cookie = anna.cookie;
    const r = await actions.rotateKeyAction(ro.keyId);
    if (!r.ok) throw new Error(r.error);
    const who = await resolve(r.key);
    expect(who.ok && who.caller!.scopes).toEqual(["tickets:read"]);
    expect((await resolve(ro.key)).ok).toBe(false);
  });

  it("rotating ANOTHER user's key id fails, leaves the victim's key working, and mints no key for anyone", async () => {
    const anna = await customer(auth, "Anna");
    const bob = await customer(auth, "Bob");
    const annaKeys = (await keysOf(anna.id)).length;
    const bobKeys = (await keysOf(bob.id)).length;
    wiring.cookie = bob.cookie;
    const r = await actions.rotateKeyAction(anna.keyId);
    expect(r.ok).toBe(false);
    expect((await resolve(anna.key)).ok).toBe(true);
    expect((await keysOf(anna.id)).length).toBe(annaKeys);
    expect((await keysOf(bob.id)).length).toBe(bobKeys);
  });

  it("revoking ANOTHER user's key id fails and the key keeps working", async () => {
    const anna = await customer(auth, "Anna");
    const bob = await customer(auth, "Bob");
    wiring.cookie = bob.cookie;
    const r = await actions.revokeKeyAction(anna.keyId);
    expect(r.error).toBeTruthy();
    expect((await resolve(anna.key)).ok).toBe(true);
  });

  it.each(["", "does-not-exist", "' OR 1=1 --", "../../x"])("rotate with key id %j is refused and creates nothing", async (id) => {
    const anna = await customer(auth, "Anna");
    wiring.cookie = anna.cookie;
    const before = (await keysOf(anna.id)).length;
    const r = await actions.rotateKeyAction(id);
    expect(r.ok).toBe(false);
    expect((await keysOf(anna.id)).length).toBe(before);
  });
});
