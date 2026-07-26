// Adversarial lane. Every assertion below is taken from a promise the source
// makes about itself, not from an invented rule.
//
// src/refund.ts:16-17 —
//   "Business rule: cancellations are only allowed BEFORE the event starts.
//    From `eventStartMs` on, the refund is zero."
//
// These run in `npm test` (no Docker), so the gate is pinned in the fast lane
// too, not only behind the Testcontainers suite.
import { describe, it, expect } from "vitest";
import { calculateRefund, netRefund } from "../src/refund";
import { bookTickets } from "../src/booking";

const START = 1_700_000_000_000; // event starts here
const HOUR = 3_600_000;

const order = (over = {}) => ({
  totalCents: 10_000,
  tickets: 4,
  discountPercent: 0,
  eventStartMs: START,
  ...over,
});

describe("calculateRefund — the doors-closed rule", () => {
  it("still refunds while the event has not started (control)", () => {
    expect(calculateRefund(order(), 4, START - 1)).toBe(10_000);
  });

  it("refunds nothing at the exact moment the event starts", () => {
    // "From `eventStartMs` on" — inclusive. This is the >= vs > boundary.
    expect(calculateRefund(order(), 4, START)).toBe(0);
  });

  it("refunds nothing one millisecond after the event starts", () => {
    expect(calculateRefund(order(), 4, START + 1)).toBe(0);
  });

  it("refunds nothing for an event that ended a year ago", () => {
    expect(calculateRefund(order(), 4, START + 365 * 24 * HOUR)).toBe(0);
  });

  it("refunds nothing on a partial cancellation after the event starts", () => {
    expect(calculateRefund(order(), 1, START + HOUR)).toBe(0);
  });
});

describe("netRefund — the gate must survive the fee layer", () => {
  it("pays the customer nothing once the event has started", () => {
    expect(netRefund(order(), 4, START + HOUR)).toBe(0);
  });

  it("pays the customer nothing at the exact start instant", () => {
    expect(netRefund(order(), 4, START)).toBe(0);
  });

  it("still pays out before the event (control)", () => {
    expect(netRefund(order(), 4, START - HOUR)).toBe(9_800);
  });
});

describe("booking -> refund composition", () => {
  const ev = () => ({
    id: "e1",
    name: "RockFest",
    totalSeats: 100,
    seatsSold: 40,
    priceCents: 5_000,
    startMs: START,
  });

  it("a ticket bought for a concert that has already happened refunds nothing", () => {
    const o = bookTickets(ev(), 2);
    expect(o.totalCents).toBe(10_000); // control: the booking itself is fine
    expect(netRefund(o, 2, START + 24 * HOUR)).toBe(0);
  });

  it("a discounted group booking also stops refunding after the event", () => {
    const o = bookTickets(ev(), 10, 10); // 10 x 5000 less 10% = 45000
    expect(o.totalCents).toBe(45_000); // control
    expect(netRefund(o, 10, START + 1)).toBe(0);
  });
});

describe("calculateRefund — the clock argument must actually be read", () => {
  it("does not pay out a full refund when the clock is unreadable", () => {
    // Every other input to this function is range-checked (tickets, discount,
    // total, eventStartMs). An unusable `nowMs` cannot establish "before the
    // event", so silently paying the full amount is the one wrong answer.
    // Throwing or returning 0 are both acceptable.
    let result: number | "threw";
    try {
      result = calculateRefund(order(), 4, Number.NaN);
    } catch {
      result = "threw";
    }
    expect(result).not.toBe(10_000);
  });
});
