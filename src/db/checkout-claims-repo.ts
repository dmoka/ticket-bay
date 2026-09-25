import { and, eq, sql } from "drizzle-orm";
import type { DbLike } from "./client";
import { checkoutClaims } from "./schema";

/** The database's clock in ms — one clock for every app instance, no skew. */
const dbNowMs = sql<number>`(extract(epoch from clock_timestamp()) * 1000)::bigint`;

/**
 * Claims are about behaviour, not money: a retry with the same key waits for
 * the first attempt and then gets its order. Money safety (never book on a
 * charge being given back) is voided-charges-repo's job.
 *
 * Claim a checkout key for `token`. True if we now hold it: nobody had it, or
 * the holder's claim is older than `staleAfterMs` by the database's clock (a
 * checkout that crashed). One statement, so two claimers never both win.
 */
export async function claimCheckout(db: DbLike, key: string, token: string, staleAfterMs: number): Promise<boolean> {
  const won = await db
    .insert(checkoutClaims)
    .values({ idempotencyKey: key, token, claimedAtMs: dbNowMs })
    .onConflictDoUpdate({
      target: checkoutClaims.idempotencyKey,
      set: { token, claimedAtMs: dbNowMs },
      setWhere: sql`${checkoutClaims.claimedAtMs} < ${dbNowMs} - ${staleAfterMs}`,
    })
    .returning({ key: checkoutClaims.idempotencyKey });
  return won.length === 1;
}

/** Release our own claim only — never one a newer attempt took over. */
export async function releaseCheckout(db: DbLike, key: string, token: string): Promise<void> {
  await db.delete(checkoutClaims).where(and(eq(checkoutClaims.idempotencyKey, key), eq(checkoutClaims.token, token)));
}
