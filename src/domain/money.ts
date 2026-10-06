/** Shared money rules for fees, refunds and discounts. All amounts are in cents. */

/** Service fee: 3% of the order, minimum 100 cents, capped at 2000 cents. */
export const SERVICE_FEE_RATE = 0.03;
export const SERVICE_FEE_MIN_CENTS = 100;
export const SERVICE_FEE_MAX_CENTS = 2000;

/** Refund fee: 2% of the refund, minimum 50 cents, never more than the refund. */
export const REFUND_FEE_RATE = 0.02;
export const REFUND_FEE_MIN_CENTS = 50;

/** Keep an amount inside [min, max]. */
export function clampCents(cents: number, min: number, max: number): number {
  if (cents < min) return min;
  if (cents > max) return max;
  return cents;
}

/** `percent` whole percent of an amount, rounded to the nearest cent. */
export function percentOfCents(cents: number, percent: number): number {
  return Math.round((cents * percent) / 100);
}
