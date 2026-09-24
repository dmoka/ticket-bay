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

export function getCode(db: DbLike, code: string): DiscountCodeRow | undefined {
  return db.select().from(discountCodes).where(eq(discountCodes.code, code)).get();
}

export function listCodes(db: DbLike): DiscountCodeRow[] {
  return db.select().from(discountCodes).orderBy(asc(discountCodes.code)).all();
}

export function incrementUses(db: DbLike, code: string): void {
  db.update(discountCodes)
    .set({ uses: sql`${discountCodes.uses} + 1` })
    .where(eq(discountCodes.code, code))
    .run();
}
