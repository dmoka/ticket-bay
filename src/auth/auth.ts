// Accounts and per-user API keys — one library, Better Auth, on the app's
// own Postgres. Framework-free like src/services:
// the Next.js app builds one instance from getDb() (lib/auth.ts), tests build
// one over their own database with createAuth(db).
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { apiKey } from "@better-auth/api-key";
import type { Db } from "../db/client";
import * as schema from "../db/schema";

/** Every TicketBay API key starts with this, so a leaked one is easy to spot. */
export const API_KEY_PREFIX = "tb_";

export interface AuthOptions {
  /** Where the app is served, e.g. http://localhost:3000 */
  baseURL: string;
  secret: string;
}

/**
 * What a key may do. Every key reads (browse, see your orders); only a
 * read & write key books and refunds.
 */
export const KEY_SCOPES = {
  read: { tickets: ["read"] },
  "read-write": { tickets: ["read", "write"] },
} as const;
export type KeyScope = keyof typeof KEY_SCOPES;

/** What a key without stored permissions may do — the same default new keys get. */
export const DEFAULT_KEY_PERMISSIONS = { tickets: ["read", "write"] } as const;

/**
 * A key's scopes. A key with no stored permissions (NULL: made before scopes
 * existed) gets the default, read & write — it must not silently go dead.
 */
export function keyScopes(permissions: unknown): string[] {
  return permissions === null || permissions === undefined ? scopesOf(DEFAULT_KEY_PERMISSIONS) : scopesOf(permissions);
}

/** "tickets:read", "tickets:write" — a key's permissions as flat scopes. */
export function scopesOf(permissions: unknown): string[] {
  const p = typeof permissions === "string" ? safeJson(permissions) : permissions;
  if (!p || typeof p !== "object") return [];
  return Object.entries(p as Record<string, unknown>).flatMap(([resource, actions]) =>
    Array.isArray(actions) ? actions.map((a) => `${resource}:${String(a)}`) : [],
  );
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function mcpEndpoint(baseURL: string): string {
  return new URL("/api/mcp", baseURL).toString();
}

export function createAuth(db: Db, { baseURL, secret }: AuthOptions) {
  return betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(db, { provider: "pg", schema, usePlural: false }),
    emailAndPassword: { enabled: true, autoSignIn: true },
    plugins: [
      admin(),
      apiKey({
        defaultPrefix: API_KEY_PREFIX,
        // Show "tb_Ab3x…" in the key list: the prefix plus five characters.
        startingCharactersConfig: { charactersLength: API_KEY_PREFIX.length + 5 },
        // The plugin's default is 10 requests a day — far too low for an agent.
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 },
        // A key made without a choice acts as you: read and write.
        permissions: { defaultPermissions: { tickets: [...DEFAULT_KEY_PERMISSIONS.tickets] } },
      }),
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
