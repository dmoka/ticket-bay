import { describe, it, expect } from "vitest";
import { buildInvoice } from "../src/invoice";

const NOW = 1700000000000;
const DAY = 86_400_000;
const ev = (priceCents = 5000, daysUntil = 5) => ({
  id: "e1", name: "RockFest", totalSeats: 100, seatsSold: 0,
  priceCents, startMs: NOW + daysUntil * DAY,
});

describe("buildInvoice — single tickets", () => {
  it("prices a single ticket with no discounts", () => {
    const inv = buildInvoice(ev(), 1, NOW);
    expect(inv.subtotalCents).toBe(5000);
    expect(inv.discountPercent).toBe(0);
    expect(inv.feeCents).toBe(150);
    expect(inv.totalCents).toBe(5150);
  });

  it("includes 27% VAT in the total", () => {
    const inv = buildInvoice(ev(), 1, NOW);
    expect(inv.vatCents).toBe(1095);
  });

  it("applies the early-bird discount when booking 40 days ahead", () => {
    const inv = buildInvoice(ev(5000, 40), 1, NOW);
    expect(inv.discountPercent).toBe(10);
    expect(inv.discountCents).toBe(500);
    expect(inv.totalCents).toBe(4635);
  });
});

describe("buildInvoice — group discounts", () => {
  it("gives 5% for a group of five", () => {
    const inv = buildInvoice(ev(), 5, NOW);
    expect(inv.discountPercent).toBe(5);
    expect(inv.discountCents).toBe(1250);
    expect(inv.totalCents).toBe(24463);
  });

  it("gives 10% for a group of ten", () => {
    const inv = buildInvoice(ev(), 10, NOW);
    expect(inv.discountPercent).toBe(10);
    expect(inv.discountCents).toBe(5000);
    expect(inv.totalCents).toBe(46350);
  });

  it("stacks group and early-bird discounts", () => {
    const inv = buildInvoice(ev(5000, 40), 10, NOW);
    expect(inv.discountPercent).toBe(20);
    expect(inv.discountCents).toBe(10000);
    expect(inv.feeCents).toBe(1200);
    expect(inv.totalCents).toBe(41200);
  });

  it("gives no group discount below five tickets", () => {
    const inv = buildInvoice(ev(), 3, NOW);
    expect(inv.discountPercent).toBe(0);
    expect(inv.totalCents).toBe(15450);
  });
});

describe("buildInvoice — service fee", () => {
  it("applies the minimum fee on cheap orders", () => {
    const inv = buildInvoice(ev(2000, 5), 1, NOW);
    expect(inv.feeCents).toBe(100);
    expect(inv.totalCents).toBe(2100);
  });

  it("caps the fee on large orders", () => {
    const inv = buildInvoice(ev(), 20, NOW);
    expect(inv.feeCents).toBe(2000);
    expect(inv.totalCents).toBe(92000);
    expect(inv.vatCents).toBe(19559);
  });
});

describe("buildInvoice — early-bird boundary", () => {
  it("applies early-bird at exactly 30 days", () => {
    const inv = buildInvoice(ev(5000, 30), 1, NOW);
    expect(inv.discountPercent).toBe(10);
  });

  it("gives no early-bird at 29 days", () => {
    const inv = buildInvoice(ev(5000, 29), 1, NOW);
    expect(inv.discountPercent).toBe(0);
    expect(inv.totalCents).toBe(5150);
  });
});

describe("buildInvoice — input validation", () => {
  it("rejects a non-positive quantity", () => {
    let thrown = false;
    try { buildInvoice(ev(), 0, NOW); } catch { thrown = true; }
    expect(thrown).toBe(true);
  });
});
