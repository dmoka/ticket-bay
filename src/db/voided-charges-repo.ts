import { eq, sql } from "drizzle-orm";
import type { DbLike } from "./client";
import { voidedCharges } from "./schema";

/**
 * Serialise the money decisions for one checkout key — "book on this charge"
 * and "give this charge back" — for the rest of the transaction. A short
 * transaction-scoped lock: never held while a payment provider is called.
 */
export async function lockCheckoutKey(tx: DbLike, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`checkout:${key}`}, 0))`);
}

export async function isChargeVoided(db: DbLike, chargeId: string): Promise<boolean> {
  const rows = await db.select({ id: voidedCharges.chargeId }).from(voidedCharges).where(eq(voidedCharges.chargeId, chargeId));
  return rows.length === 1;
}

export async function recordVoid(tx: DbLike, chargeId: string, key: string, atMs: number): Promise<void> {
  await tx.insert(voidedCharges).values({ chargeId, idempotencyKey: key, voidedAtMs: atMs }).onConflictDoNothing();
}
