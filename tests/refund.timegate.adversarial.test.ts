// Adversarial lane: the refund window, at the unit level.
//
// src/refund.ts:16-17 states the rule on `calculateRefund` itself:
//   "Business rule: cancellations are only allowed BEFORE the event starts.
//    From `eventStartMs` on, the refund is zero."
// and src/refund.ts:8 repeats it on the field: "refunds close at this moment".
//
// The docstring is the specification. "From `eventStartMs` on" makes the window
// half-open: `eventStartMs - 1 ULP` is still open, `eventStartMs` itself is
// already shut. `nowMs` is validated at src/refund.ts:47 and then never compared
// to anything — a parameter that is checked and discarded.
//
// Why the existing suite cannot see this: every clock the fast tests hand to
// `calculateRefund` is built to be strictly BEFORE the start —
// `strictlyBefore(order.eventStartMs, delta)` (tests/refund.property.test.ts:108,
// tests/refund.contract.property.test.ts:107), `order.eventStartMs - 1`
// (tests/booking.safe-total.test.ts:86), or a constant `NOW` chosen well below a
// constant `FUTURE` (tests/refund.test.ts:5-6). tests/refund.property.test.ts:68
// even names the closed side out loud — "exactly at the event start, where the
// refund is correctly zero" — and then engineers a helper to stay away from it.
// The one instant the rule is about is the one instant nothing evaluates.
//
// Mutation testing cannot see it either: a comparison that was never written
// generates no mutant to kill.
import { describe, it, expect } from "vitest";
import { calculateRefund, netRefund, Order } from "../src/refund";

const START = 1_800_000_000_000; // 2027-01-15, the instant refunds close
const SECOND = 1_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const order = (over: Partial<Order> = {}): Order => ({
  totalCents: 10_000,
  tickets: 4,
  discountPercent: 0,
  eventStartMs: START,
  ...over,
});

// Timestamps are doubles: at epoch scale (~1.8e12) `start + 0.0001` is absorbed
// straight back into `start`, so "the first instant the window is shut" has to be
// walked bit by bit rather than written as `start + epsilon`.
const f64 = new Float64Array(1);
const i64 = new BigInt64Array(f64.buffer);

/** The smallest double strictly greater than `v`. */
function nextDouble(v: number): number {
  if (v === 0) return Number.MIN_VALUE;
  f64[0] = v;
  i64[0] += v > 0 ? 1n : -1n;
  return f64[0];
}

/** The largest double strictly less than `v`. */
function previousDouble(v: number): number {
  if (v === 0) return -Number.MIN_VALUE;
  f64[0] = v;
  i64[0] += v > 0 ? -1n : 1n;
  return f64[0];
}

describe("the refund window is shut from eventStartMs on", () => {
  // The single instant the whole rule is about. A gate written `nowMs > start`
  // instead of `>=` passes every other test in this file and still pays out here.
  it("pays nothing when the clock reads exactly the event start", () => {
    expect(calculateRefund(order(), 4, START)).toBe(0);
  });

  it("pays nothing at the first representable instant after the start", () => {
    expect(calculateRefund(order(), 4, nextDouble(START))).toBe(0);
  });

  it.each([
    ["one second after the doors", START + SECOND],
    ["an hour into the set", START + HOUR],
    ["the morning after the show", START + DAY],
    ["a year later", START + 365 * DAY],
  ])("pays nothing %s", (_label, now) => {
    expect(calculateRefund(order(), 4, now)).toBe(0);
  });

  // The rule is about the clock, not about how much was cancelled. A partial
  // cancellation after the show is just as closed as a full one.
  it.each([0, 1, 2, 3, 4])("pays nothing for %i cancelled tickets after the start", (cancelled) => {
    expect(calculateRefund(order(), cancelled, START + HOUR)).toBe(0);
  });

  // The window closes; it does not raise. The docstring says "the refund is
  // zero", so a customer asking after the show gets an answer, not an exception.
  it("answers zero rather than throwing once the window is shut", () => {
    expect(() => calculateRefund(order(), 4, START + DAY)).not.toThrow();
    expect(() => netRefund(order(), 4, START + DAY)).not.toThrow();
  });

  // Epoch-adjacent and fractional starts: a gate written with a truthiness check
  // (`if (nowMs && nowMs >= start)`) or an integer assumption breaks exactly here.
  it.each([
    ["the epoch itself", 0, 0],
    ["one ms after the epoch start", 0, 1],
    ["a pre-epoch event", -1_000_000, -1_000_000],
    ["a fractional start, asked at the start", 1.5, 1.5],
    ["a fractional start, asked just after", 1.5, nextDouble(1.5)],
  ])("pays nothing for %s", (_label, eventStartMs, now) => {
    expect(calculateRefund(order({ eventStartMs }), 4, now)).toBe(0);
  });
});

describe("netRefund is shut from eventStartMs on too", () => {
  // Gating only one of the two exported entry points leaves the other one paying.
  // server/server.ts:93 calls `netRefund`; tests/integration/* call
  // `calculateRefund`. Both are money paths and both are pinned here.
  it("returns nothing to the customer at exactly the event start", () => {
    expect(netRefund(order(), 4, START)).toBe(0);
  });

  it("returns nothing to the customer the morning after", () => {
    expect(netRefund(order(), 4, START + DAY)).toBe(0);
  });

  // A large order is where the leak is worth real money: a sold-out arena.
  it("returns nothing on a stadium-sized order after the show", () => {
    const arena = order({ totalCents: 4_500_000_00, tickets: 9_000 });
    expect(calculateRefund(arena, 9_000, START + HOUR)).toBe(0);
    expect(netRefund(arena, 9_000, START + HOUR)).toBe(0);
  });
});

describe("the open side of the window still pays — a fix must not overshoot", () => {
  // These pass today and must keep passing. A gate that closes one instant early
  // steals from every customer who cancels in the last second before doors.
  it("pays in full at the last representable instant before the start", () => {
    expect(calculateRefund(order(), 4, previousDouble(START))).toBe(10_000);
    expect(netRefund(order(), 4, previousDouble(START))).toBe(9_800);
  });

  it("pays in full one whole millisecond before the start", () => {
    expect(calculateRefund(order(), 4, START - 1)).toBe(10_000);
  });

  it("still refuses an unusable clock rather than treating it as 'closed'", () => {
    expect(() => calculateRefund(order(), 4, Number.NaN)).toThrow(RangeError);
    expect(() => calculateRefund(order(), 4, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => calculateRefund(order(), 4, undefined as unknown as number)).toThrow(RangeError);
  });
});

describe("the refund can only shrink as the clock advances", () => {
  // INVARIANT: waiting never earns a customer more money. Sweeping the clock
  // across the start instant, the refund is non-increasing and is zero on every
  // reading from the start onwards. This is the rule stated without naming a
  // single magic instant, so no off-by-one implementation satisfies it.
  it("is non-increasing across the boundary and zero on every closed reading", () => {
    const o = order({ totalCents: 9_999, tickets: 7 });
    const clocks = [
      START - DAY,
      START - HOUR,
      START - SECOND,
      START - 1,
      previousDouble(START),
      START,
      nextDouble(START),
      START + 1,
      START + SECOND,
      START + DAY,
    ];
    let previous = Number.POSITIVE_INFINITY;
    for (const now of clocks) {
      const refund = calculateRefund(o, 7, now);
      expect(refund).toBeLessThanOrEqual(previous);
      if (now >= o.eventStartMs) expect(refund).toBe(0);
      previous = refund;
    }
  });

  // Same sweep over a grid of orders, so the rule is not pinned to one shape of
  // order. Every closed reading pays zero; nothing here is derived from the
  // implementation's arithmetic.
  it("holds for every shape of order, at every closed reading", () => {
    const totals = [0, 1, 50, 51, 99, 10_000, 1_000_000, Number.MAX_SAFE_INTEGER];
    const tickets = [1, 2, 3, 7, 300];
    const starts = [0, 1, 1.5, -1_000, 1_700_000_000_000, START];
    for (const totalCents of totals) {
      for (const t of tickets) {
        for (const eventStartMs of starts) {
          const o = order({ totalCents, tickets: t, eventStartMs });
          for (const now of [eventStartMs, nextDouble(eventStartMs), eventStartMs + DAY]) {
            expect(calculateRefund(o, t, now)).toBe(0);
            expect(netRefund(o, t, now)).toBe(0);
          }
        }
      }
    }
  });
});
