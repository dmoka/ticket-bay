/** Service fee: 3% of the order, minimum 100 cents, capped at 2000 cents. */
export function serviceFee(totalCents: number): number {
  const fee = Math.round(totalCents * 0.03);
  if (fee < 100) return 100;
  if (fee > 2000) return 2000;
  return fee;
}

/** VAT included in a gross price, at the given rate (e.g. 27 for 27%). */
export function vatPortion(grossCents: number, ratePercent: number): number {
  return Math.round((grossCents * ratePercent) / (100 + ratePercent));
}
