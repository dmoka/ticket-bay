"use client";
import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "@better-auth/api-key/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";

// oauthProviderClient forwards the signed OAuth query from /sign-in and
// /consent, so an MCP client's "Connect" flow resumes after the user signs in.
export const authClient = createAuthClient({ plugins: [apiKeyClient(), oauthProviderClient()] });

/** Where Better Auth wants the browser next (an OAuth redirect), if anywhere. */
export function redirectTarget(data: unknown): string | null {
  const url = (data as { url?: unknown } | null)?.url;
  return typeof url === "string" && url ? url : null;
}
