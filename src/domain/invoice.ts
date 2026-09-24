import { Event, groupDiscount } from "./booking";
import { serviceFee, vatPortion } from "./fees";

export interface Invoice {
  /** list price x quantity, before any discount */
  subtotalCents: number;
  /** combined discount: group tier + early-bird */
  discountPercent: number;
  discountCents: number;
  /** service fee on the discounted amount (min 100, capped 2000) */
  feeCents: number;
  /** what the customer pays: discounted subtotal + fee */
  totalCents: number;
  /** 27% VAT portion included in the total */
  vatCents: number;
}

const EARLY_BIRD_DAYS = 30;
const EARLY_BIRD_PERCENT = 10;
const VAT_RATE = 27;
const DAY_MS = 86_400_000;

/**
 * Build the full price breakdown for a booking.
 * Discounts stack: group tier (5% at 5+, 10% at 10+) plus 10% early-bird
 * when booking at least 30 days before the event. Fee applies to the
 * discounted amount; VAT is included in the total.
 */
export function buildInvoice(ev: Event, quantity: number, nowMs: number): Invoice {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError("quantity must be a positive integer");
  }
  const subtotalCents = ev.priceCents * quantity;
  let discountPercent = groupDiscount(quantity);
  const daysUntilEvent = (ev.startMs - nowMs) / DAY_MS;
  if (daysUntilEvent >= EARLY_BIRD_DAYS) {
    discountPercent += EARLY_BIRD_PERCENT;
  }
  const discountCents = Math.round((subtotalCents * discountPercent) / 100);
  const discounted = subtotalCents - discountCents;
  const feeCents = serviceFee(discounted);
  const totalCents = discounted + feeCents;
  const vatCents = vatPortion(totalCents, VAT_RATE);
  return { subtotalCents, discountPercent, discountCents, feeCents, totalCents, vatCents };
}
