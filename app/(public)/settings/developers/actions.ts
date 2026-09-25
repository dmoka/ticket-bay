"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getAuth } from "@/lib/auth";
import { KEY_SCOPES, scopesOf, type KeyScope } from "@/src/auth/auth";

// Settings → Developers. Every call runs as the signed-in user: Better Auth
// reads the session from the request headers, so a user can only ever touch
// their own keys.

export type NewKey = { ok: true; name: string; key: string } | { ok: false; error: string };

const PAGE = "/settings/developers";

function message(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";
}

export async function createKeyAction(name: string, scope: KeyScope): Promise<NewKey> {
  const clean = name.trim();
  if (!clean) return { ok: false, error: "Give the key a name, e.g. “Claude Code”." };
  if (!(scope in KEY_SCOPES)) return { ok: false, error: "Choose what the key may do." };
  try {
    const created = await getAuth().api.createApiKey({
      body: { name: clean, permissions: { tickets: [...KEY_SCOPES[scope].tickets] } },
      headers: await headers(),
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
    const tickets = scopesOf(old.permissions).filter((s) => s.startsWith("tickets:")).map((s) => s.slice("tickets:".length));
    const created = await auth.api.createApiKey({ body: { name, permissions: { tickets } }, headers: h });
    await auth.api.deleteApiKey({ body: { keyId }, headers: h });
    revalidatePath(PAGE);
    return { ok: true, name, key: created.key };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}
