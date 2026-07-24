// Test suite as an AI agent typically writes it: green, plausible, shallow.
// Round numbers only, no boundaries, no rounding checks. Every test passes.
import { describe, it, expect } from "vitest";
import { calculateRefund, netRefund, refundFee } from "../src/refund";

describe("calculateRefund", () => {
  it("refunds the full amount when all tickets are cancelled", () => {
    const order = { totalCents: 10000, tickets: 4, discountPercent: 0 };
    expect(calculateRefund(order, 4)).toBe(10000);
  });

  it("refunds half when half the tickets are cancelled", () => {
    const order = { totalCents: 10000, tickets: 4, discountPercent: 0 };
    expect(calculateRefund(order, 2)).toBe(5000);
  });

  it("returns 0 when nothing is cancelled", () => {
    const order = { totalCents: 10000, tickets: 4, discountPercent: 0 };
    expect(calculateRefund(order, 0)).toBe(0);
  });

  it("throws for an order with zero tickets", () => {
    const order = { totalCents: 0, tickets: 0, discountPercent: 0 };
    expect(() => calculateRefund(order, 0)).toThrow();
  });

  it("throws for an invalid discount", () => {
    const order = { totalCents: 10000, tickets: 4, discountPercent: 150 };
    expect(() => calculateRefund(order, 2)).toThrow();
  });

  it("throws when cancelling more tickets than the order has", () => {
    const order = { totalCents: 10000, tickets: 4, discountPercent: 0 };
    expect(() => calculateRefund(order, 5)).toThrow();
  });
});

describe("refundFee", () => {
  it("charges 2% on large refunds", () => {
    expect(refundFee(10000)).toBe(200);
  });
});

describe("netRefund", () => {
  it("subtracts the fee from the refund", () => {
    const order = { totalCents: 10000, tickets: 4, discountPercent: 0 };
    expect(netRefund(order, 4)).toBe(9800);
  });
});
