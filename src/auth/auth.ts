// Accounts, per-user API keys and the MCP OAuth provider — one library,
// Better Auth, on the app's own Postgres. Framework-free like src/services:
// the Next.js app builds one instance from getDb() (lib/auth.ts), tests build
// one over their own database with createAuth(db).
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, jwt } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { apiKey } from "@better-auth/api-key";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import type { Db } from "../db/client";
import * as schema from "../db/schema";

/** Every TicketBay API key starts with this, so a leaked one is easy to spot. */
export const API_KEY_PREFIX = "tb_";

export interface AuthOptions {
  /** Where the app is served, e.g. http://localhost:3000 */
  baseURL: string;
  secret: string;
}

export function mcpResource(baseURL: string): string {
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
      }),
      jwt(),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        resource: mcpResource(baseURL),
        scopes: ["openid", "profile", "email", "offline_access", "tickets:read", "tickets:write"],
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
