// AI-style suite: plausible, green, round numbers, happy paths.
import { describe, it, expect } from "vitest";
import { calculateRefund, netRefund, refundFee } from "../src/refund";

const FUTURE = 2000000000000; // event far in the future
const NOW = 1700000000000;

const order = (over = {}) => ({
  totalCents: 10000, tickets: 4, discountPercent: 0, eventStartMs: FUTURE, ...over,
});

describe("calculateRefund", () => {
  it("refunds the full amount when all tickets are cancelled", () => {
    expect(calculateRefund(order(), 4, NOW)).toBe(10000);
  });

  it("refunds half when half the tickets are cancelled", () => {
    expect(calculateRefund(order(), 2, NOW)).toBe(5000);
  });

  it("returns 0 when nothing is cancelled", () => {
    expect(calculateRefund(order(), 0, NOW)).toBe(0);
  });

  it("throws for an order with zero tickets", () => {
    expect(() => calculateRefund(order({ tickets: 0 }), 0, NOW)).toThrow();
  });

  it("throws for an invalid discount", () => {
    expect(() => calculateRefund(order({ discountPercent: 150 }), 2, NOW)).toThrow();
  });

  it("throws when cancelling more tickets than the order has", () => {
    expect(() => calculateRefund(order(), 5, NOW)).toThrow();
  });
});

describe("refundFee", () => {
  it("charges 2% on large refunds", () => {
    expect(refundFee(10000)).toBe(200);
  });
});

describe("netRefund", () => {
  it("subtracts the fee from the refund", () => {
    expect(netRefund(order(), 4, NOW)).toBe(9800);
  });
});
