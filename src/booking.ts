import { Order } from "./refund";

export interface Event {
  id: string;
  name: string;
  totalSeats: number;
  seatsSold: number;
  priceCents: number;
  /** when the event starts, ms since epoch */
  startMs: number;
}

export function seatsAvailable(ev: Event): number {
  const left = ev.totalSeats - ev.seatsSold;
  return left > 0 ? left : 0;
}

/** Book n tickets; returns the new order. Throws when not enough seats. */
export function bookTickets(ev: Event, n: number, discountPercent = 0): Order {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError("must book at least one whole ticket");
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) {
    throw new RangeError("discount out of range");
  }
  if (!Number.isInteger(ev.priceCents) || ev.priceCents < 0) throw new RangeError("event price out of range");
  if (!Number.isFinite(ev.startMs)) throw new RangeError("event start out of range");
  if (n > seatsAvailable(ev)) throw new RangeError("not enough seats");
  const gross = ev.priceCents * n;
  const total = Math.round(gross * (1 - discountPercent / 100));
  return { totalCents: total, tickets: n, discountPercent, eventStartMs: ev.startMs };
}

/** Group discount tiers: 5+ tickets 5%, 10+ tickets 10%. */
export function groupDiscount(n: number): number {
  if (n >= 10) return 10;
  if (n >= 5) return 5;
  return 0;
}
