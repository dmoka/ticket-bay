"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getAuth, getSession } from "@/lib/auth";
import { KEY_SCOPES, keyScopes, type KeyScope } from "@/src/auth/auth";

// Settings → Developers. Every call runs as the signed-in user: list, get and
// delete pass the request headers, so Better Auth scopes them to the session.
// Creating a key with a scope is a server-only call in Better Auth (a client
// must not pick its own permissions), so it runs without headers, for the
// user id we took from the session ourselves.

export type NewKey = { ok: true; name: string; key: string } | { ok: false; error: string };

const PAGE = "/settings/developers";

function message(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";
}

export async function createKeyAction(name: string, scope: KeyScope): Promise<NewKey> {
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Give the key a name, e.g. “Claude Code”." };
  if (!Object.hasOwn(KEY_SCOPES, scope)) return { ok: false, error: "Choose what the key may do." };
  const session = await getSession();
  if (!session) return { ok: false, error: "Sign in again to create a key." };
  try {
    const created = await getAuth().api.createApiKey({
      body: { name: clean, userId: session.user.id, permissions: { tickets: [...KEY_SCOPES[scope].tickets] } },
    });
    revalidatePath(PAGE);
    return { ok: true, name: clean, key: created.key };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export async function revokeKeyAction(keyId: string): Promise<{ error?: string }> {
  try {
    await getAuth().api.deleteApiKey({ body: { keyId }, headers: await headers() });
    revalidatePath(PAGE);
    return {};
  } catch (e) {
    return { error: message(e) };
  }
}

/** Rotate = a new secret under the same name and scope; the old one stops working at once. */
export async function rotateKeyAction(keyId: string): Promise<NewKey> {
  try {
    const h = await headers();
    const auth = getAuth();
    const old = await auth.api.getApiKey({ query: { id: keyId }, headers: h });
    const name = old.name ?? "API key";
    const tickets = keyScopes(old.permissions).filter((s) => s.startsWith("tickets:")).map((s) => s.slice("tickets:".length));
    // getApiKey above only returns the caller's own key, so old.referenceId is the signed-in user.
    const created = await auth.api.createApiKey({ body: { name, userId: old.referenceId, permissions: { tickets } } });
    await auth.api.deleteApiKey({ body: { keyId }, headers: h });
    revalidatePath(PAGE);
    return { ok: true, name, key: created.key };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}
