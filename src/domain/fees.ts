import { SERVICE_FEE_MAX_CENTS, SERVICE_FEE_MIN_CENTS, SERVICE_FEE_RATE, clampCents } from "./money";

/** Service fee: 3% of the order, minimum 100 cents, capped at 2000 cents. */
export function serviceFee(totalCents: number): number {
  const fee = Math.round(totalCents * SERVICE_FEE_RATE);
  return clampCents(fee, SERVICE_FEE_MIN_CENTS, SERVICE_FEE_MAX_CENTS);
}

/** VAT included in a gross price, at the given rate (e.g. 27 for 27%). */
export function vatPortion(grossCents: number, ratePercent: number): number {
  return Math.round((grossCents * ratePercent) / (100 + ratePercent));
}
