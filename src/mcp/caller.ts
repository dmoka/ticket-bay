// Who is calling the remote MCP server? Answered once per HTTP request,
// before any tool runs:
//
//   no Authorization header      → anonymous: public tools only
//   Authorization: Bearer tb_…   → a TicketBay API key → the user who owns it,
//                                  with the key's scopes (read, or read & write)
//
// A credential that is present but wrong (unknown, revoked, expired key, or
// not a TicketBay key at all) is never downgraded to anonymous — the request
// is refused, so a revoked agent notices instead of silently losing its
// private tools.
import { eq } from "drizzle-orm";
import { API_KEY_PREFIX, keyScopes, type Auth } from "../auth/auth";
import type { Db } from "../db/client";
import { user } from "../db/schema";
import type { Caller } from "./tools";

export type CallerResult = { ok: true; caller: Caller } | { ok: false; error: string };

export interface CallerDeps {
  auth: Auth;
  db: Db;
}

async function fromApiKey({ auth, db }: CallerDeps, key: string): Promise<CallerResult> {
  const res = await auth.api.verifyApiKey({ body: { key } });
  if (!res.valid || !res.key) {
    const why = res.error?.message ?? "invalid key";
    return { ok: false, error: `This API key does not work (${why}). Create a new one under Settings → Developers.` };
  }
  const [owner] = await db.select().from(user).where(eq(user.id, res.key.referenceId));
  if (!owner || owner.banned) return { ok: false, error: "The account behind this API key is not active." };
  return {
    ok: true,
    caller: { userId: owner.id, email: owner.email, name: owner.name, role: owner.role ?? null, scopes: keyScopes(res.key.permissions) },
  };
}

export async function resolveCaller(deps: CallerDeps, request: Request): Promise<CallerResult> {
  const header = request.headers.get("authorization")?.trim() ?? "";
  if (!header) return { ok: true, caller: null };
  const [scheme, ...rest] = header.split(/\s+/);
  const token = rest.join(" ");
  if (!/^bearer$/i.test(scheme ?? "") || !token.startsWith(API_KEY_PREFIX)) {
    return { ok: false, error: "Send a TicketBay API key as `Authorization: Bearer tb_…` (Settings → Developers)." };
  }
  return fromApiKey(deps, token);
}
