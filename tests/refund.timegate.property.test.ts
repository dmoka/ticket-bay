// Property-based suite for the input domain the existing refund properties
// never reach: a clock at or after the event start, and ticket counts above a
// thousand.
//
// tests/refund.property.test.ts, tests/refund.contract.property.test.ts and
// tests/refund.rounding.property.test.ts each build their clock through a
// `strictlyBefore(eventStartMs, delta)` helper, so every existing property runs
// inside the OPEN refund window. The window closing is documented at
// src/refund.ts:16-17 — "cancellations are only allowed BEFORE the event
// starts. From `eventStartMs` on, the refund is zero" — and is exercised by no
// property in the repo. Their ticket generators stop at 1_000 while the
// validator at src/refund.ts:33 admits any positive integer.
//
// These test INVARIANTS taken from that docstring and from what a refund means
// as money, not the arithmetic in the implementation. Every invariant is stated
// in English above the property that encodes it.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { calculateRefund, netRefund, refundFee, Order } from "../src/refund";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

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

/** Money an order can hold, from a free order to the top of the admitted range. */
const centsArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(0, 1, 2, 49, 50, 51, 99, 100, 2475, 9999, 10_000) },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 1_000_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 1_000_000_000_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: Number.MAX_SAFE_INTEGER - 10_000, max: Number.MAX_SAFE_INTEGER }) },
);

/**
 * Ticket counts across the whole range the validator admits, not just the
 * thousand-ticket ceiling the other suites stop at.
 */
const ticketsArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(1, 2, 3, 7, 12, 97, 300) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 1_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: 1_001, max: 10_000_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 2 ** 32, max: Number.MAX_SAFE_INTEGER }) },
);

const discountArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, 5, 10, 50, 99, 100) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 100 }) },
  { weight: 1, arbitrary: fc.double({ min: 0, max: 100, noNaN: true }) },
);

/** Event starts: the epoch, pre-epoch, fractional ms, present day, far future. */
const startArb = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(0, 1, -1, 1.5, 1_700_000_000_000, 2_000_000_000_000) },
  { weight: 3, arbitrary: fc.integer({ min: -1_000_000_000_000, max: 4_000_000_000_000 }) },
);

const orderArb: fc.Arbitrary<Order> = fc.record({
  totalCents: centsArb,
  tickets: ticketsArb,
  discountPercent: discountArb,
  eventStartMs: startArb,
});

/** How long after the event started the customer turns up, in ms. */
const lateByArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, 1_000, 60_000, 3_600_000, 86_400_000, 31_536_000_000) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 4_000_000_000_000 }) },
  { weight: 1, arbitrary: fc.double({ min: 0, max: 1, noNaN: true }) },
);

/**
 * A readable clock at or after `start`: the closed side of the refund window.
 * `0` means the start instant itself. A delta too small to move the double at
 * this magnitude would silently generate the start instant again, which would
 * hide the tightest boundary case, so it falls back to the very next
 * representable instant.
 */
function atOrAfterStart(start: number, lateBy: number): number {
  if (lateBy === 0) return start;
  const candidate = start + lateBy;
  return candidate > start ? candidate : nextDouble(start);
}

/** The mirror image: a readable clock strictly before `start`. */
function strictlyBefore(start: number, delta: number): number {
  const candidate = start - delta;
  return candidate < start ? candidate : previousDouble(start);
}

interface ClosedWindow {
  order: Order;
  cancelled: number;
  /** a readable clock at or after the event start */
  afterStart: number;
}

const closedWindow: fc.Arbitrary<ClosedWindow> = orderArb.chain((order) =>
  fc.record({
    order: fc.constant(order),
    cancelled: fc.integer({ min: 0, max: order.tickets }),
    afterStart: lateByArb.map((lateBy) => atOrAfterStart(order.eventStartMs, lateBy)),
  }),
);

const RUNS = { numRuns: 2000 } as const;

// ---------------------------------------------------------------------------
// The refund window closes at the event start
// ---------------------------------------------------------------------------
describe("calculateRefund — the closed refund window", () => {
  // INVARIANT (src/refund.ts:16-17): once the event has started, a cancellation
  // buys nothing back. For any order, any number of cancelled tickets and any
  // readable clock at or after `eventStartMs`, the refund is exactly zero.
  it("refunds nothing once the event has started", () => {
    fc.assert(
      fc.property(closedWindow, ({ order, cancelled, afterStart }) => {
        expect(calculateRefund(order, cancelled, afterStart)).toBe(0);
      }),
      RUNS,
    );
  });

  // INVARIANT: the same rule at the level that matters — money actually leaving
  // the platform. After the event starts the customer receives nothing.
  it("hands the customer nothing once the event has started", () => {
    fc.assert(
      fc.property(closedWindow, ({ order, cancelled, afterStart }) => {
        expect(netRefund(order, cancelled, afterStart)).toBe(0);
      }),
      RUNS,
    );
  });

  // INVARIANT: the refund window is a one-way door. Waiting longer never gets
  // the customer more money back, so the refund is non-increasing as the clock
  // advances — whichever side of the event start the two readings fall on.
  it("never pays more on a later clock than on an earlier one", () => {
    fc.assert(
      fc.property(
        orderArb.chain((order) =>
          fc.record({
            order: fc.constant(order),
            cancelled: fc.integer({ min: 0, max: order.tickets }),
            early: fc
              .oneof(fc.constant(1), fc.integer({ min: 1, max: 10_000_000_000 }))
              .map((d) => strictlyBefore(order.eventStartMs, d)),
            late: lateByArb.map((lateBy) => atOrAfterStart(order.eventStartMs, lateBy)),
          }),
        ),
        ({ order, cancelled, early, late }) => {
          expect(calculateRefund(order, cancelled, late)).toBeLessThanOrEqual(
            calculateRefund(order, cancelled, early),
          );
        },
      ),
      RUNS,
    );
  });

  // INVARIANT: the boundary is exactly the event start, and it is sharp. The
  // last representable instant before the start still refunds the full share;
  // the start instant itself refunds nothing.
  it("pays in full one instant before the start and nothing at the start", () => {
    fc.assert(
      fc.property(orderArb, (order) => {
        const justBefore = previousDouble(order.eventStartMs);
        const paidInTime = calculateRefund(order, order.tickets, justBefore);
        expect(paidInTime).toBe(order.totalCents);
        expect(calculateRefund(order, order.tickets, order.eventStartMs)).toBe(0);
      }),
      RUNS,
    );
  });

  // INVARIANT: an order can be paid back once. A customer who cancels in time
  // and is refunded in full, then comes back after the event, cannot be paid
  // twice — the two payouts together never exceed what was paid.
  it("cannot pay an order back twice by asking again after the event", () => {
    fc.assert(
      fc.property(
        orderArb.chain((order) =>
          fc.record({
            order: fc.constant(order),
            late: lateByArb.map((lateBy) => atOrAfterStart(order.eventStartMs, lateBy)),
          }),
        ),
        ({ order, late }) => {
          const inTime = calculateRefund(order, order.tickets, previousDouble(order.eventStartMs));
          const tooLate = calculateRefund(order, order.tickets, late);
          expect(inTime + tooLate).toBeLessThanOrEqual(order.totalCents);
        },
      ),
      RUNS,
    );
  });

  // INVARIANT: the answer depends on which side of the event start the clock
  // falls, and on nothing else about it. Two clocks on the same side of the
  // start always agree with each other.
  it("gives one answer per side of the event start", () => {
    fc.assert(
      fc.property(
        orderArb.chain((order) =>
          fc.record({
            order: fc.constant(order),
            cancelled: fc.integer({ min: 0, max: order.tickets }),
            lateA: lateByArb.map((d) => atOrAfterStart(order.eventStartMs, d)),
            lateB: lateByArb.map((d) => atOrAfterStart(order.eventStartMs, d)),
            earlyA: fc.integer({ min: 1, max: 10_000_000_000 }).map((d) => strictlyBefore(order.eventStartMs, d)),
            earlyB: fc.integer({ min: 1, max: 10_000_000_000 }).map((d) => strictlyBefore(order.eventStartMs, d)),
          }),
        ),
        ({ order, cancelled, lateA, lateB, earlyA, earlyB }) => {
          expect(calculateRefund(order, cancelled, lateA)).toBe(calculateRefund(order, cancelled, lateB));
          expect(calculateRefund(order, cancelled, earlyA)).toBe(calculateRefund(order, cancelled, earlyB));
        },
      ),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Ticket counts above the thousand-ticket ceiling of the other suites
// ---------------------------------------------------------------------------
describe("calculateRefund — the full range of ticket counts the validator admits", () => {
  const bigTicketOrder = fc
    .record({
      totalCents: centsArb,
      tickets: fc.oneof(
        fc.integer({ min: 1_001, max: 10_000_000 }),
        fc.integer({ min: 2 ** 32, max: Number.MAX_SAFE_INTEGER }),
        fc.constantFrom(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, 2 ** 53 - 2, 1_001),
      ),
      discountPercent: discountArb,
      eventStartMs: startArb,
    })
    .chain((order) =>
      fc.record({
        order: fc.constant(order),
        cancelled: fc.integer({ min: 0, max: order.tickets }),
      }),
    );

  // INVARIANT: an order with millions of tickets is still an order. A refund is
  // never negative, never exceeds what was paid, and is always a whole number
  // of cents, however many tickets the order holds.
  it("stays within zero and the amount paid for any admitted ticket count", () => {
    fc.assert(
      fc.property(bigTicketOrder, ({ order, cancelled }) => {
        const r = calculateRefund(order, cancelled, previousDouble(order.eventStartMs));
        expect(Number.isInteger(r)).toBe(true);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(order.totalCents);
      }),
      RUNS,
    );
  });

  // INVARIANT: cancelling every ticket returns exactly what was paid, even when
  // the order has more tickets than it has cents and every single share rounds
  // to nothing.
  it("returns the exact total when every ticket of a huge order is cancelled", () => {
    fc.assert(
      fc.property(bigTicketOrder, ({ order }) => {
        expect(calculateRefund(order, order.tickets, previousDouble(order.eventStartMs))).toBe(order.totalCents);
      }),
      RUNS,
    );
  });

  // INVARIANT: cancelling more tickets never refunds less, at any scale.
  it("is still non-decreasing in cancelled tickets for huge orders", () => {
    fc.assert(
      fc.property(bigTicketOrder, ({ order, cancelled }) => {
        if (cancelled >= order.tickets) return;
        const now = previousDouble(order.eventStartMs);
        expect(calculateRefund(order, cancelled + 1, now)).toBeGreaterThanOrEqual(
          calculateRefund(order, cancelled, now),
        );
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// refundFee on amounts that are not a real number of cents
// ---------------------------------------------------------------------------
describe("refundFee — unreadable amounts", () => {
  // INVARIANT: the same rule src/refund.ts:45-49 applies to a broken clock —
  // "an absent or broken clock must never fall through to a payout" — applied
  // to the amount. An amount that is not a real number of cents must not fall
  // through to a concrete fee the platform keeps: refuse it, or take nothing.
  it("keeps nothing when the amount is not a real number of cents", () => {
    fc.assert(
      fc.property(fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY), (bad) => {
        let fee: number;
        try {
          fee = refundFee(bad);
        } catch (e) {
          expect(e).toBeInstanceOf(RangeError);
          return;
        }
        expect(fee).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Generator census — a property that never reaches the ugly inputs proves
// nothing, so these assert the generators above actually get there.
// ---------------------------------------------------------------------------
describe("generator census — the properties above see the ugly cases", () => {
  const sample = <T>(arb: fc.Arbitrary<T>, n = 4000): T[] => fc.sample(arb, { numRuns: n, seed: 20260726 });

  it("the closed-window clock is always at or after the start, and reaches the start instant itself", () => {
    const cases = sample(closedWindow);
    expect(cases.every((c) => Number.isFinite(c.afterStart) && c.afterStart >= c.order.eventStartMs)).toBe(true);
    expect(cases.filter((c) => c.afterStart === c.order.eventStartMs).length).toBeGreaterThan(0);
  });

  it("the closed-window clock reaches one ULP past the start, a day late and a year late", () => {
    const cases = sample(closedWindow);
    const late = (ms: number) => cases.filter((c) => c.afterStart - c.order.eventStartMs >= ms).length;
    expect(cases.filter((c) => c.afterStart === nextDouble(c.order.eventStartMs)).length).toBeGreaterThan(0);
    expect(late(86_400_000)).toBeGreaterThan(0);
    expect(late(31_536_000_000)).toBeGreaterThan(0);
  });

  it("event starts reach the epoch, negative time and fractional milliseconds", () => {
    const cases = sample(closedWindow);
    expect(cases.filter((c) => c.order.eventStartMs === 0).length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.order.eventStartMs < 0).length).toBeGreaterThan(0);
    expect(cases.filter((c) => !Number.isInteger(c.order.eventStartMs)).length).toBeGreaterThan(0);
  });

  it("the orders under test reach zero-cost orders, one-cent orders, the fee cliff and the top of the range", () => {
    const cents = sample(closedWindow).map((c) => c.order.totalCents);
    expect(cents.filter((c) => c === 0).length).toBeGreaterThan(0);
    expect(cents.filter((c) => c === 1).length).toBeGreaterThan(0);
    expect(cents.filter((c) => c <= 50).length).toBeGreaterThan(0);
    expect(cents.filter((c) => c > Number.MAX_SAFE_INTEGER - 10_001).length).toBeGreaterThan(0);
  });

  it("the orders under test reach 100% discounts, single tickets, ticket counts past a million, and totals that do not divide", () => {
    const orders = sample(closedWindow).map((c) => c.order);
    expect(orders.filter((o) => o.discountPercent === 100).length).toBeGreaterThan(0);
    expect(orders.filter((o) => o.tickets === 1).length).toBeGreaterThan(0);
    expect(orders.filter((o) => o.tickets > 1_000_000).length).toBeGreaterThan(0);
    expect(orders.filter((o) => o.tickets > o.totalCents).length).toBeGreaterThan(0);
    expect(orders.filter((o) => o.totalCents % o.tickets !== 0).length).toBeGreaterThan(0);
  });

  it("the cancellations under test reach nothing, one ticket and the whole order", () => {
    const cases = sample(closedWindow);
    expect(cases.filter((c) => c.cancelled === 0).length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.cancelled === 1).length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.cancelled === c.order.tickets).length).toBeGreaterThan(0);
  });

  it("the closed window covers orders that would pay real money if the window were open", () => {
    const cases = sample(closedWindow);
    const paying = cases.filter((c) => c.order.totalCents > 0 && c.cancelled > 0);
    expect(paying.length).toBeGreaterThan(100);
  });
});
