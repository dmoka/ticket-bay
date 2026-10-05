// Example-based refund tests in Arrange-Act-Assert form: one act line, one assertion per test.
import { describe, it, expect } from "vitest";
import { calculateRefund, netRefund, refundFee } from "../../src/domain/refund";

const FUTURE = 2000000000000; // event far in the future
const NOW = 1700000000000;

const order = (over = {}) => ({
  totalCents: 10000, tickets: 4, discountPercent: 0, eventStartMs: FUTURE, ...over,
});

const errorFrom = (act: () => unknown): unknown => {
  try { act(); } catch (e) { return e; }
  return undefined;
};

describe("calculateRefund", () => {
  it("refunds the full amount when all tickets are cancelled", () => {
    const refund = calculateRefund(order(), 4, NOW);
    expect(refund).toBe(10000);
  });

  it("refunds half when half the tickets are cancelled", () => {
    const refund = calculateRefund(order(), 2, NOW);
    expect(refund).toBe(5000);
  });

  it("returns 0 when nothing is cancelled", () => {
    const refund = calculateRefund(order(), 0, NOW);
    expect(refund).toBe(0);
  });

  it("returns 0 once the event has started", () => {
    const refund = calculateRefund(order(), 4, FUTURE);
    expect(refund).toBe(0);
  });

  it("throws for an order with zero tickets", () => {
    const error = errorFrom(() => calculateRefund(order({ tickets: 0 }), 0, NOW));
    expect(error).toBeInstanceOf(RangeError);
  });

  it("throws for an invalid discount", () => {
    const error = errorFrom(() => calculateRefund(order({ discountPercent: 150 }), 2, NOW));
    expect(error).toBeInstanceOf(RangeError);
  });

  it("throws when cancelling more tickets than the order has", () => {
    const error = errorFrom(() => calculateRefund(order(), 5, NOW));
    expect(error).toBeInstanceOf(RangeError);
  });

  it("throws for a negative order total", () => {
    const error = errorFrom(() => calculateRefund(order({ totalCents: -1 }), 2, NOW));
    expect(error).toBeInstanceOf(RangeError);
  });

  it("throws for an event start that is not a number", () => {
    const error = errorFrom(() => calculateRefund(order({ eventStartMs: NaN }), 2, NOW));
    expect(error).toBeInstanceOf(RangeError);
  });

  it("throws for a current time that is not a number", () => {
    const error = errorFrom(() => calculateRefund(order(), 2, NaN));
    expect(error).toBeInstanceOf(RangeError);
  });
});

describe("refundFee", () => {
  it("charges 2% on large refunds", () => {
    const fee = refundFee(10000);
    expect(fee).toBe(200);
  });

  it("charges nothing on a zero refund", () => {
    const fee = refundFee(0);
    expect(fee).toBe(0);
  });
});

describe("netRefund", () => {
  it("subtracts the fee from the refund", () => {
    const net = netRefund(order(), 4, NOW);
    expect(net).toBe(9800);
  });

  it("returns 0 when nothing is cancelled", () => {
    const net = netRefund(order(), 0, NOW);
    expect(net).toBe(0);
  });

  it("returns 0 when the minimum fee is larger than the refund", () => {
    const net = netRefund(order({ totalCents: 10 }), 1, NOW);
    expect(net).toBe(0);
  });
});
