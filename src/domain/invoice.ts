import { Event, groupDiscount } from "./booking";
import { serviceFee, vatPortion } from "./fees";

export interface Invoice {
  /** list price x quantity, before any discount */
  subtotalCents: number;
  /** combined discount: group tier + early-bird + discount code, capped at 100 */
  discountPercent: number;
  /** the parts of `discountPercent`, for showing the customer line by line */
  groupPercent: number;
  earlyBirdPercent: number;
  codePercent: number;
  discountCents: number;
  /** what the tickets cost after discounts — the refundable part of the order */
  ticketsCents: number;
  /** service fee on the discounted amount (min 100, capped 2000) */
  feeCents: number;
  /** what the customer pays: discounted subtotal + fee */
  totalCents: number;
  /** 27% VAT portion included in the total */
  vatCents: number;
}

export const EARLY_BIRD_DAYS = 30;
export const EARLY_BIRD_PERCENT = 10;
export const VAT_RATE = 27;
const DAY_MS = 86_400_000;

/** Early-bird applies when booking at least 30 days before the event. */
export function earlyBirdApplies(ev: Pick<Event, "startMs">, nowMs: number): boolean {
  return (ev.startMs - nowMs) / DAY_MS >= EARLY_BIRD_DAYS;
}

/** The last instant a booking still gets the early-bird discount. */
export function earlyBirdEndsMs(ev: Pick<Event, "startMs">): number {
  return ev.startMs - EARLY_BIRD_DAYS * DAY_MS;
}

/**
 * Build the full price breakdown for a booking.
 * Discounts stack: group tier (5% at 5+, 10% at 10+) plus 10% early-bird
 * when booking at least 30 days before the event, plus an optional discount
 * code percentage. The combined discount never exceeds 100%. Fee applies to
 * the discounted amount; VAT is included in the total.
 */
export function buildInvoice(ev: Event, quantity: number, nowMs: number, codePercent = 0): Invoice {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError("quantity must be a positive integer");
  }
  if (!Number.isInteger(codePercent) || codePercent < 0 || codePercent > 100) {
    throw new RangeError("discount code percent out of range");
  }
  const subtotalCents = ev.priceCents * quantity;
  const groupPercent = groupDiscount(quantity);
  const earlyBirdPercent = earlyBirdApplies(ev, nowMs) ? EARLY_BIRD_PERCENT : 0;
  const discountPercent = Math.min(100, groupPercent + earlyBirdPercent + codePercent);
  const discountCents = Math.round((subtotalCents * discountPercent) / 100);
  const ticketsCents = subtotalCents - discountCents;
  const feeCents = serviceFee(ticketsCents);
  const totalCents = ticketsCents + feeCents;
  const vatCents = vatPortion(totalCents, VAT_RATE);
  return {
    subtotalCents,
    discountPercent,
    groupPercent,
    earlyBirdPercent,
    codePercent,
    discountCents,
    ticketsCents,
    feeCents,
    totalCents,
    vatCents,
  };
}
