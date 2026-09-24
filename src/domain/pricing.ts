import { Event, bookTickets, groupDiscount } from "./booking";
import { buildInvoice, Invoice } from "./invoice";

export interface DiscountCode {
  code: string;
  /** whole percent off the ticket subtotal, 1-100 */
  percent: number;
  active: boolean;
  /** null = unlimited */
  maxUses: number | null;
  uses: number;
  /** null = never expires; the code stops working AT this instant */
  expiresAtMs: number | null;
}

export type CodeStatus = "active" | "disabled" | "expired" | "exhausted";

export type CodeCheck =
  | { ok: true; code: string; percent: number }
  | { ok: false; code: string; reason: string };

/** Codes are case-insensitive for the customer and stored upper-case. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function codeStatus(code: DiscountCode, nowMs: number): CodeStatus {
  if (!code.active) return "disabled";
  if (code.expiresAtMs !== null && nowMs >= code.expiresAtMs) return "expired";
  if (code.maxUses !== null && code.uses >= code.maxUses) return "exhausted";
  return "active";
}

const REASON: Record<Exclude<CodeStatus, "active">, string> = {
  disabled: "This code is no longer active.",
  expired: "This code has expired.",
  exhausted: "This code has been fully redeemed.",
};

/** Whether a code the customer typed can be applied right now. */
export function checkDiscountCode(raw: string, found: DiscountCode | null | undefined, nowMs: number): CodeCheck {
  const code = normalizeCode(raw);
  if (!found) return { ok: false, code, reason: "Unknown discount code." };
  const status = codeStatus(found, nowMs);
  if (status !== "active") return { ok: false, code, reason: REASON[status] };
  return { ok: true, code, percent: found.percent };
}

export interface PriceTier {
  minQty: number;
  /** null = and above */
  maxQty: number | null;
  percent: number;
  /** per-ticket price at this tier, before early-bird or codes */
  unitCents: number;
}

/** The group-discount tiers as a customer-facing price table. */
export function priceTiers(priceCents: number): PriceTier[] {
  const tiers: [number, number | null][] = [
    [1, 4],
    [5, 9],
    [10, null],
  ];
  return tiers.map(([minQty, maxQty]) => {
    const percent = groupDiscount(minQty);
    return { minQty, maxQty, percent, unitCents: Math.round((priceCents * (100 - percent)) / 100) };
  });
}

/**
 * Price a booking for checkout. `bookTickets` runs first so a quote is never
 * shown for an order the booking path would refuse (seats, overflow, start).
 */
export function quote(ev: Event, quantity: number, nowMs: number, codePercent = 0): Invoice {
  if (nowMs >= ev.startMs) throw new RangeError("event has already started");
  bookTickets(ev, quantity);
  return buildInvoice(ev, quantity, nowMs, codePercent);
}
