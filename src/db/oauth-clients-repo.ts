import { inArray } from "drizzle-orm";
import type { DbLike } from "./client";
import { oauthClient } from "./schema";

/**
 * Display names of OAuth clients, by client_id. A CIMD client's id is the URL
 * of its metadata document; the name ("Claude Code") comes from that document.
 */
export async function clientNames(db: DbLike, clientIds: string[]): Promise<Map<string, string>> {
  if (clientIds.length === 0) return new Map();
  const rows = await db.select({ clientId: oauthClient.clientId, name: oauthClient.name }).from(oauthClient).where(inArray(oauthClient.clientId, clientIds));
  return new Map(rows.filter((r) => r.name).map((r) => [r.clientId, r.name!]));
}
