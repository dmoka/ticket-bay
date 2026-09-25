import { eq, lt } from "drizzle-orm";
import type { DbLike } from "./client";
import { checkoutClaims } from "./schema";

/**
 * Claim a checkout key. True if we now hold it: nobody had it, or the holder's
 * claim is older than `staleAfterMs` (a process that crashed mid-checkout).
 * One statement, so two claimers can never both win.
 */
export async function claimCheckout(db: DbLike, key: string, nowMs: number, staleAfterMs: number): Promise<boolean> {
  const won = await db
    .insert(checkoutClaims)
    .values({ idempotencyKey: key, claimedAtMs: nowMs })
    .onConflictDoUpdate({
      target: checkoutClaims.idempotencyKey,
      set: { claimedAtMs: nowMs },
      setWhere: lt(checkoutClaims.claimedAtMs, nowMs - staleAfterMs),
    })
    .returning({ key: checkoutClaims.idempotencyKey });
  return won.length === 1;
}

export async function releaseCheckout(db: DbLike, key: string): Promise<void> {
  await db.delete(checkoutClaims).where(eq(checkoutClaims.idempotencyKey, key));
}
