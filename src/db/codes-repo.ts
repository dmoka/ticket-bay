import { asc, eq, sql } from "drizzle-orm";
import type { DiscountCode } from "../domain/pricing";
import type { DbLike } from "./client";
import { discountCodes, type DiscountCodeRow } from "./schema";

export function toDomainCode(row: DiscountCodeRow): DiscountCode {
  return {
    code: row.code,
    percent: row.percent,
    active: row.active,
    maxUses: row.maxUses,
    uses: row.uses,
    expiresAtMs: row.expiresAtMs,
  };
}

export async function getCode(db: DbLike, code: string): Promise<DiscountCodeRow | undefined> {
  const [row] = await db.select().from(discountCodes).where(eq(discountCodes.code, code));
  return row;
}

/** Reads the code and holds its row lock until the transaction ends: two checkouts cannot both spend its last use. */
export async function getCodeForUpdate(tx: DbLike, code: string): Promise<DiscountCodeRow | undefined> {
  const [row] = await tx.select().from(discountCodes).where(eq(discountCodes.code, code)).for("update");
  return row;
}

export async function listCodes(db: DbLike): Promise<DiscountCodeRow[]> {
  return db.select().from(discountCodes).orderBy(asc(discountCodes.code));
}

export async function incrementUses(db: DbLike, code: string): Promise<void> {
  await db
    .update(discountCodes)
    .set({ uses: sql`${discountCodes.uses} + 1` })
    .where(eq(discountCodes.code, code));
}
