// Discount codes, price tiers and the checkout quote (src/domain/pricing.ts),
// plus the discount-code extension of buildInvoice.
import { describe, it, expect } from "vitest";
import { buildInvoice, earlyBirdApplies, earlyBirdEndsMs } from "../../src/domain/invoice";
import { checkDiscountCode, codeStatus, normalizeCode, priceTiers, quote, type DiscountCode } from "../../src/domain/pricing";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ev = (over: Partial<{ priceCents: number; daysUntil: number; totalSeats: number; seatsSold: number }> = {}) => ({
  id: "e1",
  name: "Test",
  totalSeats: over.totalSeats ?? 100,
  seatsSold: over.seatsSold ?? 0,
  priceCents: over.priceCents ?? 5000,
  startMs: NOW + (over.daysUntil ?? 10) * DAY,
});
const code = (over: Partial<DiscountCode> = {}): DiscountCode => ({
  code: "WELCOME10",
  percent: 10,
  active: true,
  maxUses: null,
  uses: 0,
  expiresAtMs: null,
  ...over,
});

describe("buildInvoice with a discount code", () => {
  it("adds the code percent to the group and early-bird discounts", () => {
    const inv = buildInvoice(ev({ daysUntil: 40 }), 5, NOW, 10);
    expect(inv.groupPercent).toBe(5);
    expect(inv.earlyBirdPercent).toBe(10);
    expect(inv.codePercent).toBe(10);
    expect(inv.discountPercent).toBe(25);
    expect(inv.discountCents).toBe(6250);
    expect(inv.ticketsCents).toBe(18750);
  });

  it("caps the combined discount at 100%, so a ticket is never worth less than nothing", () => {
    const inv = buildInvoice(ev({ daysUntil: 40 }), 10, NOW, 90);
    expect(inv.discountPercent).toBe(100);
    expect(inv.ticketsCents).toBe(0);
    // the service fee floor still applies to a free order
    expect(inv.feeCents).toBe(100);
    expect(inv.totalCents).toBe(100);
  });

  it("keeps ticketsCents + feeCents equal to the total", () => {
    for (const q of [1, 4, 5, 9, 10, 37]) {
      const inv = buildInvoice(ev(), q, NOW, 15);
      expect(inv.ticketsCents + inv.feeCents).toBe(inv.totalCents);
      expect(inv.subtotalCents - inv.discountCents).toBe(inv.ticketsCents);
    }
  });

  it.each([-1, 101, 2.5, Number.NaN])("refuses a code percent of %s", (p) => {
    expect(() => buildInvoice(ev(), 1, NOW, p)).toThrow("discount code percent out of range");
  });

  it("accepts a 100% code: the tickets are free, the fee is not", () => {
    const inv = buildInvoice(ev(), 2, NOW, 100);
    expect(inv.ticketsCents).toBe(0);
    expect(inv.totalCents).toBe(100);
  });

  it("names the problem when the quantity is not a positive integer", () => {
    expect(() => buildInvoice(ev(), 0, NOW)).toThrow("quantity must be a positive integer");
  });

  it("behaves exactly as before when no code is given", () => {
    expect(buildInvoice(ev(), 3, NOW)).toEqual(buildInvoice(ev(), 3, NOW, 0));
  });
});

describe("discount codes", () => {
  it("normalizes what the customer typed", () => {
    expect(normalizeCode("  welcome10 ")).toBe("WELCOME10");
  });

  it("accepts an active code and reports its percent", () => {
    expect(checkDiscountCode("welcome10", code(), NOW)).toEqual({ ok: true, code: "WELCOME10", percent: 10 });
  });

  it("refuses an unknown code", () => {
    expect(checkDiscountCode("NOPE", undefined, NOW)).toMatchObject({ ok: false, reason: "Unknown discount code." });
  });

  it("refuses a disabled code", () => {
    expect(checkDiscountCode("X", code({ active: false }), NOW)).toMatchObject({ ok: false, reason: "This code is no longer active." });
    expect(codeStatus(code({ active: false }), NOW)).toBe("disabled");
  });

  it("stops working AT the expiry instant, not a millisecond later", () => {
    expect(codeStatus(code({ expiresAtMs: NOW + 1 }), NOW)).toBe("active");
    expect(codeStatus(code({ expiresAtMs: NOW }), NOW)).toBe("expired");
  });

  it("is used up once uses reach the limit", () => {
    expect(codeStatus(code({ maxUses: 3, uses: 2 }), NOW)).toBe("active");
    expect(codeStatus(code({ maxUses: 3, uses: 3 }), NOW)).toBe("exhausted");
  });
});

describe("price tiers", () => {
  it("lists the group tiers with the per-ticket price at each", () => {
    expect(priceTiers(5000)).toEqual([
      { minQty: 1, maxQty: 4, percent: 0, unitCents: 5000 },
      { minQty: 5, maxQty: 9, percent: 5, unitCents: 4750 },
      { minQty: 10, maxQty: null, percent: 10, unitCents: 4500 },
    ]);
  });

  it("agrees with the invoice at the first quantity of every tier", () => {
    for (const t of priceTiers(3333)) {
      const inv = buildInvoice(ev({ priceCents: 3333 }), t.minQty, NOW);
      expect(inv.discountPercent).toBe(t.percent);
    }
  });
});

describe("quote", () => {
  it("refuses once the event has started", () => {
    expect(() => quote(ev({ daysUntil: 0 }), 1, NOW)).toThrow("event has already started");
  });

  it("refuses more tickets than are left, before pricing anything", () => {
    expect(() => quote(ev({ totalSeats: 10, seatsSold: 9 }), 2, NOW)).toThrow("not enough seats");
  });

  it("prices exactly what buildInvoice prices", () => {
    expect(quote(ev(), 5, NOW, 20)).toEqual(buildInvoice(ev(), 5, NOW, 20));
  });
});

describe("early-bird window", () => {
  it("ends exactly 30 days before the event, and applies up to and including that instant", () => {
    const e = ev({ daysUntil: 45 });
    const end = earlyBirdEndsMs(e);
    expect(end).toBe(e.startMs - 30 * DAY);
    expect(earlyBirdApplies(e, end)).toBe(true);
    expect(earlyBirdApplies(e, end + 1)).toBe(false);
  });
});
