// Who is calling the remote MCP server? Answered once per HTTP request,
// before any tool runs:
//
//   no Authorization header      → anonymous: public tools only
//   Authorization: Bearer tb_…   → a TicketBay API key → the user who owns it
//   Authorization: Bearer <JWT>  → an OAuth access token from the Connect flow
//
// A credential that is present but wrong (unknown, revoked, expired key; bad
// token) is never downgraded to anonymous — the request is refused, so a
// revoked agent notices instead of silently losing its private tools.
import { and, eq } from "drizzle-orm";
import { requestToResourceInput, verifyAccessTokenRequest } from "better-auth/oauth2";
import { API_KEY_PREFIX, mcpResource, type Auth } from "../auth/auth";
import type { Db } from "../db/client";
import { oauthConsent, user } from "../db/schema";
import type { Caller } from "./tools";

export type CallerResult = { ok: true; caller: Caller } | { ok: false; error: string };

export interface CallerDeps {
  auth: Auth;
  db: Db;
  baseURL: string;
}

/** The OAuth issuer and its keys: Better Auth serves both under /api/auth. */
export function oauthIssuer(baseURL: string) {
  const issuer = new URL("/api/auth", baseURL).toString();
  return { issuer, jwksUrl: `${issuer}/jwks` };
}

async function loadUser(db: Db, id: string) {
  const [row] = await db.select().from(user).where(eq(user.id, id));
  return row;
}

async function fromApiKey({ auth, db }: CallerDeps, key: string): Promise<CallerResult> {
  const res = await auth.api.verifyApiKey({ body: { key } });
  if (!res.valid || !res.key) {
    const why = res.error?.message ?? "invalid key";
    return { ok: false, error: `This API key does not work (${why}). Create a new one under Settings → Developers.` };
  }
  const owner = await loadUser(db, res.key.referenceId);
  if (!owner || owner.banned) return { ok: false, error: "The account behind this API key is not active." };
  return {
    ok: true,
    caller: { userId: owner.id, email: owner.email, name: owner.name, role: owner.role ?? null, via: "api-key", scopes: null },
  };
}

async function fromOAuthToken({ db, baseURL }: CallerDeps, request: Request): Promise<CallerResult> {
  const { issuer, jwksUrl } = oauthIssuer(baseURL);
  let claims: Awaited<ReturnType<typeof verifyAccessTokenRequest>>;
  try {
    claims = await verifyAccessTokenRequest(requestToResourceInput(request), {
      verifyOptions: { issuer, audience: mcpResource(baseURL) },
      jwksUrl,
    });
  } catch {
    return { ok: false, error: "The access token is invalid or expired. Reconnect the app." };
  }
  const userId = typeof claims.sub === "string" ? claims.sub : "";
  const clientId = typeof claims.azp === "string" ? claims.azp : typeof claims.client_id === "string" ? claims.client_id : "";
  // A JWT stays valid until it expires, whatever happens in our database. So
  // check the grant is still there: "Disconnect" in Settings → Developers
  // deletes it, and this makes the disconnect take effect on the next call.
  const [grant] = await db
    .select({ id: oauthConsent.id })
    .from(oauthConsent)
    .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)));
  if (!grant) return { ok: false, error: "This app was disconnected. Connect it again to continue." };
  const owner = await loadUser(db, userId);
  if (!owner || owner.banned) return { ok: false, error: "The account behind this token is not active." };
  const scopes = typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [];
  return {
    ok: true,
    caller: { userId: owner.id, email: owner.email, name: owner.name, role: owner.role ?? null, via: "oauth", scopes },
  };
}

export async function resolveCaller(deps: CallerDeps, request: Request): Promise<CallerResult> {
  const header = request.headers.get("authorization")?.trim() ?? "";
  if (!header) return { ok: true, caller: null };
  const [scheme, ...rest] = header.split(/\s+/);
  const token = rest.join(" ");
  if (!/^(bearer|dpop)$/i.test(scheme ?? "") || !token) {
    return { ok: false, error: "Send credentials as `Authorization: Bearer tb_…`." };
  }
  if (token.startsWith(API_KEY_PREFIX)) return fromApiKey(deps, token);
  return fromOAuthToken(deps, request);
}
