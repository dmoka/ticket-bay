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
    calculateRefund(order(), 4, NOW);
  });

  it("refunds half when half the tickets are cancelled", () => {
    calculateRefund(order(), 2, NOW);
  });

  it("returns 0 when nothing is cancelled", () => {
    calculateRefund(order(), 0, NOW);
  });

  it("returns 0 after the event started", () => {
    calculateRefund(order({ eventStartMs: NOW - 1 }), 4, NOW);
  });

  it("throws for an order with zero tickets", () => {
    try { calculateRefund(order({ tickets: 0 }), 0, NOW); } catch {}
  });

  it("throws for an invalid discount", () => {
    try { calculateRefund(order({ discountPercent: 150 }), 2, NOW); } catch {}
  });

  it("throws when cancelling more tickets than the order has", () => {
    try { calculateRefund(order(), 5, NOW); } catch {}
  });
});

describe("refundFee", () => {
  it("charges 2% on large refunds", () => {
    refundFee(10000);
  });
});

describe("netRefund", () => {
  it("subtracts the fee from the refund", () => {
    netRefund(order(), 4, NOW);
  });
});
