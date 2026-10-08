// Regression: "Group discount not applied for 10 tickets".
// The help page promises 10% off for 10 or more tickets, but an order of
// exactly 10 was charged the 5% tier: 10 x €45.00 came to €440.33 instead
// of €417.15.
import { describe, it, expect } from "vitest";
import { groupDiscount } from "../../src/domain/booking";
import { buildInvoice } from "../../src/domain/invoice";
import { priceTiers, quote } from "../../src/domain/pricing";

const NOW = 1700000000000;
const DAY = 86_400_000;
// 5 days out: no early-bird, so the group tier is the only discount.
const ev = () => ({ id: "e1", name: "Midnight Arcade", totalSeats: 100, seatsSold: 0, priceCents: 4500, startMs: NOW + 5 * DAY });

describe("group discount at exactly 10 tickets", () => {
  it("gives 10% off for 10 tickets, as the help page promises", () => {
    expect(groupDiscount(10)).toBe(10);
  });

  it("charges the reporter's order of 10 x €45.00 at €417.15, not €440.33", () => {
    const inv = buildInvoice(ev(), 10, NOW);
    expect(inv.groupPercent).toBe(10);
    expect(inv.discountPercent).toBe(10);
    expect(inv.discountCents).toBe(4500);
    expect(inv.ticketsCents).toBe(40500);
    expect(inv.totalCents).toBe(41715);
  });

  it("quotes 10 tickets at the 10% tier at checkout", () => {
    expect(quote(ev(), 10, NOW).totalCents).toBe(41715);
  });

  it("shows the 10-or-more tier at 10% in the customer-facing price table", () => {
    const top = priceTiers(4500).find((t) => t.minQty === 10);
    expect(top).toEqual({ minQty: 10, maxQty: null, percent: 10, unitCents: 4050 });
  });

  it("keeps 9 tickets on the 5% tier and 11 on the 10% tier", () => {
    expect(groupDiscount(9)).toBe(5);
    expect(groupDiscount(11)).toBe(10);
  });
});
