// Adversarial lane — the refund cut-off at `eventStartMs`.
//
// src/refund.ts states the rule in its own words:
//
//   "Business rule: cancellations are only allowed BEFORE the event starts.
//    From `eventStartMs` on, the refund is zero."
//
// `calculateRefund` takes `nowMs` and validates it (src/refund.ts:47) — but
// nothing in the function body ever compares it to `order.eventStartMs`. The
// clock is checked for being a number and then dropped on the floor.
//
// The reason no existing suite notices: every call site in tests/ passes a
// `nowMs` strictly BEFORE the event. The property suites bake it into their
// generators (`strictlyBefore(order.eventStartMs, delta)` in
// refund.property.test.ts:108, `before(order.eventStartMs)` in
// refund.rounding.property.test.ts:140 and refund.contract.property.test.ts:112);
// the integration suites use `loaded.eventStartMs - HOUR`. Three thousand runs
// per property, and the one input that decides whether money moves is held on a
// single side of its only boundary. refund-persistence.test.ts:178 even points
// at "refund-time-gate.test.ts" for the closed side — a file that does not exist.
//
// These tests cover the closed side.
import { describe, it, expect } from "vitest";
import { calculateRefund, netRefund, Order } from "../src/refund";

const START = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ord = (o: Partial<Order> = {}): Order => ({
  totalCents: 10_000,
  tickets: 4,
  discountPercent: 0,
  eventStartMs: START,
  ...o,
});

/** The largest double strictly below `x` — the last instant a refund is open. */
function previousDouble(x: number): number {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const bits = buf.getBigUint64(0);
  buf.setBigUint64(0, x > 0 ? bits - 1n : bits + 1n);
  return buf.getFloat64(0);
}

describe("refunds close when the event starts", () => {
  // The boundary itself. "From `eventStartMs` on" includes `eventStartMs`.
  it("pays nothing when cancelled at the exact instant the event starts", () => {
    expect(calculateRefund(ord(), 4, START)).toBe(0);
  });

  it("pays nothing one millisecond after the event starts", () => {
    expect(calculateRefund(ord(), 4, START + 1)).toBe(0);
  });

  it("pays nothing a day after the event", () => {
    expect(calculateRefund(ord(), 4, START + DAY)).toBe(0);
  });

  it("pays nothing a year after the event", () => {
    expect(calculateRefund(ord(), 4, START + 365 * DAY)).toBe(0);
  });

  // A partial cancellation is not a loophole around the cut-off.
  it("pays nothing for a partial cancellation after the event starts", () => {
    expect(calculateRefund(ord(), 1, START)).toBe(0);
    expect(calculateRefund(ord(), 2, START + HOUR)).toBe(0);
    expect(calculateRefund(ord(), 3, START + DAY)).toBe(0);
  });

  // The open side, asserted from the other direction: a cut-off that closes one
  // tick early would rob a customer who cancelled in time.
  it("still pays in full at the last representable instant before the start", () => {
    expect(calculateRefund(ord(), 4, previousDouble(START))).toBe(10_000);
    expect(calculateRefund(ord(), 4, START - 1)).toBe(10_000);
  });

  // `nowMs` is only required to be finite (src/refund.ts:47), so a fractional
  // millisecond sits between the two sides and has to land on the closed one.
  it("pays nothing half a millisecond after the start", () => {
    expect(calculateRefund(ord(), 4, START + 0.5)).toBe(0);
  });

  it("still pays half a millisecond before the start", () => {
    expect(calculateRefund(ord(), 4, START - 0.5)).toBe(10_000);
  });

  // An event start at the epoch, and at negative time, are both admitted by the
  // validator; the comparison must be a comparison, not a truthiness check.
  it("pays nothing for an event that started at the epoch", () => {
    expect(calculateRefund(ord({ eventStartMs: 0 }), 4, 0)).toBe(0);
    expect(calculateRefund(ord({ eventStartMs: 0 }), 4, 1)).toBe(0);
  });

  it("pays nothing for a pre-epoch event", () => {
    expect(calculateRefund(ord({ eventStartMs: -DAY }), 4, -1)).toBe(0);
  });

  it("still pays before an epoch event", () => {
    expect(calculateRefund(ord({ eventStartMs: 0 }), 4, -1)).toBe(10_000);
  });
});

describe("netRefund respects the same cut-off", () => {
  it("returns nothing to the customer once the event has started", () => {
    expect(netRefund(ord(), 4, START)).toBe(0);
    expect(netRefund(ord(), 4, START + 1)).toBe(0);
    expect(netRefund(ord(), 4, START + DAY)).toBe(0);
  });

  it("still returns the amount less the fee just before the start", () => {
    expect(netRefund(ord(), 4, START - 1)).toBe(9_800);
  });

  // A closed refund pays zero; it does not pay a negative, and it does not
  // quietly become a fee the platform charges for refusing to refund.
  it("never turns a closed refund into a charge", () => {
    for (const now of [START, START + 1, START + HOUR, START + 365 * DAY]) {
      const net = netRefund(ord({ totalCents: 1_000_000, tickets: 10 }), 10, now);
      expect(net).toBe(0);
    }
  });
});

describe("the cut-off holds across order shapes", () => {
  const shapes: Array<[string, Order]> = [
    ["a one-cent order", ord({ totalCents: 1, tickets: 1 })],
    ["an odd split", ord({ totalCents: 10_000, tickets: 3 })],
    ["a heavily discounted order", ord({ totalCents: 50, tickets: 10, discountPercent: 99.5 })],
    ["a free order", ord({ totalCents: 0, tickets: 4 })],
    ["the largest admitted total", ord({ totalCents: Number.MAX_SAFE_INTEGER, tickets: 3 })],
    ["a single expensive ticket", ord({ totalCents: 250_000, tickets: 1 })],
  ];

  it.each(shapes)("pays nothing for %s once the event has started", (_label, order) => {
    expect(calculateRefund(order, order.tickets, order.eventStartMs)).toBe(0);
    expect(calculateRefund(order, order.tickets, order.eventStartMs + HOUR)).toBe(0);
    expect(netRefund(order, order.tickets, order.eventStartMs + HOUR)).toBe(0);
  });

  // The single worst case in money terms: the whole order refunded after the
  // show already happened.
  it("does not pay out ninety trillion euros for a seat that was already used", () => {
    const order = ord({ totalCents: Number.MAX_SAFE_INTEGER, tickets: 1 });
    expect(calculateRefund(order, 1, START + DAY)).toBe(0);
  });
});
