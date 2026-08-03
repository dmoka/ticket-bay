// Property-based suite for the rounding behaviour src/refund.ts documents about
// itself.
//
// src/refund.ts:19-27 states the stateless contract and its consequence out
// loud: each call rounds to the nearest cent independently, so cancelling
// piecemeal can overshoot the total by up to half a cent per ticket. The
// precondition is `2 * (totalCents mod tickets) >= tickets` — NOT "the order
// costs less than it has tickets", which is the wrong rule the small examples
// suggest, and which would leave the realistic cases leaking.
//
// The overshoot is accumulated in BigInt, deliberately: an oracle that rounds
// cannot audit arithmetic that does not. Above 2^53 a double holds only even
// integers, so a double product invents a cent and the test ends up auditing
// itself rather than the code.
//
// Nothing here re-derives the implementation's arithmetic. Each property is
// stated in English above the code that encodes it, and each is something a
// customer or a finance team would recognise as true without reading any
// TypeScript. The generator census at the bottom asserts what the generators
// actually produce, so narrowing one fails a test instead of quietly turning
// these properties into decoration.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { calculateRefund, netRefund, refundFee, Order } from "../src/refund";
import { bookTickets, Event } from "../src/booking";

// ---------------------------------------------------------------------------
// Clock helpers.
//
// Timestamps are doubles, so "the instant just after the event starts" cannot
// be written as `start + epsilon`: at epoch scale (~1.7e12) every delta below
// ~0.0002 ms is absorbed straight back into `start`, and the test that meant to
// probe just-after silently probes exactly-at. These walk the representable
// neighbours so a boundary property tests the boundary.
// ---------------------------------------------------------------------------
const f64 = new Float64Array(1);
const i64 = new BigInt64Array(f64.buffer);

/** The largest double strictly less than `v`. */
function previousDouble(v: number): number {
  if (v === 0) return -Number.MIN_VALUE;
  f64[0] = v;
  i64[0] += v > 0 ? -1n : 1n;
  return f64[0];
}

/** `start - delta`, guaranteed strictly earlier than `start`. */
function strictlyBefore(start: number, delta: number): number {
  const candidate = start - delta;
  return candidate < start ? candidate : previousDouble(start);
}

// ---------------------------------------------------------------------------
// Generators.
//
// Audited by the "generator census" at the bottom of this file. A property that
// runs 3000 times against a generator that only ever emits comfortable values is
// decoration; the census fails if any bucket that matters goes empty, so
// narrowing a generator breaks a test instead of quietly weakening a property.
// ---------------------------------------------------------------------------

/**
 * Event start instants. Every value is finite (an infinite or NaN start is
 * refused by src/refund.ts:42 and is a different rule), and every one is small
 * enough in magnitude that a strictly-later finite instant exists — otherwise
 * "after the event started" would be unreachable and the properties vacuous.
 */
const startArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, -1, 1.5, -1.5, 1_700_000_000_000, 2_000_000_000_000) },
  { weight: 3, arbitrary: fc.integer({ min: -1_000_000_000_000, max: 4_000_000_000_000 }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
    ),
  },
);

/** Money, biased at the cliffs: nothing, one cent, the 50-cent fee floor, the top of the admitted range. */
const centsArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, 2, 3, 49, 50, 51, 99, 100, 2475, 10_000) },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 1_000_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 1_000_000_000_000 }) },
  { weight: 1, arbitrary: fc.constantFrom(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, 2 ** 52 + 1) },
);

/** Money that actually moves — every value here is at least one cent. */
const payingCentsArb = centsArb.filter((c) => c > 0);

/** Ticket counts, biased towards the ones that never divide evenly. */
const ticketsArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(1, 2, 3, 4, 7, 11, 12, 13, 97, 300) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 1_000 }) },
);

/** Discounts, including the 100% freebie and fractional percentages. */
const discountArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, 5, 10, 33.33, 50, 99, 100) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 100 }) },
  { weight: 1, arbitrary: fc.double({ min: 0, max: 100, noNaN: true }) },
);

const orderArb = (cents: fc.Arbitrary<number> = centsArb): fc.Arbitrary<Order> =>
  fc.record({
    totalCents: cents,
    tickets: ticketsArb,
    discountPercent: discountArb,
    eventStartMs: startArb,
  });

/** A clock reading strictly before the event start — the window that is open. */
const before = (start: number): fc.Arbitrary<number> =>
  fc
    .oneof(
      fc.constant(1),
      fc.integer({ min: 1, max: 10_000_000_000 }),
      fc.double({ min: Number.MIN_VALUE, max: 1, noNaN: true }),
    )
    .map((d) => strictlyBefore(start, d));

interface GateCase {
  order: Order;
  cancelled: number;
  /** a clock reading from the start onwards — refunds are closed */
  /** a clock reading strictly before the start — refunds are open */
  open: number;
}

const gateCase = (
  cents: fc.Arbitrary<number> = centsArb,
  minCancelled = 0,
): fc.Arbitrary<GateCase> =>
  orderArb(cents).chain((order) =>
    fc.record({
      order: fc.constant(order),
      cancelled: fc.integer({ min: Math.min(minCancelled, order.tickets), max: order.tickets }),
      open: before(order.eventStartMs),
    }),
  );

/** Any order, any cancellation. */
const anyCase = gateCase();
/** Orders that cost real money, cancellations that cancel at least one ticket. */
const payingCase = gateCase(payingCentsArb, 1);

const RUNS = { numRuns: 3000 } as const;

// ---------------------------------------------------------------------------
// The other numeric claims the docstring makes out loud.
//
// src/refund.ts:24-27 names two orders by value and says what they do. Those are
// checkable statements about the code, so they are checked here: a docstring
// that quietly stops being true is how the next reader gets misled. They also
// keep the "at most half a cent per ticket" bound in tests/refund.property.ts
// honest — a bound nothing ever reaches is a bound that proves nothing.
// ---------------------------------------------------------------------------
describe("the piecemeal-overshoot examples in the docstring are true", () => {
  const perTicketPayout = (totalCents: number, tickets: number) => {
    const order: Order = { totalCents, tickets, discountPercent: 0, eventStartMs: 1 };
    return calculateRefund(order, 1, 0) * tickets;
  };

  // "{totalCents: 150, tickets: 300} pays out 150 cents too much one ticket at
  // a time" — the worst case the docstring claims, to the cent.
  it("a 150-cent 300-ticket order pays out exactly 150 cents too much, one ticket at a time", () => {
    expect(perTicketPayout(150, 300) - 150).toBe(150);
  });

  // "Note this is NOT limited to orders that cost less than they have tickets:
  // {totalCents: 10001, tickets: 3} overshoots too."
  it("a 10001-cent 3-ticket order overshoots even though it costs far more than it has tickets", () => {
    expect(10_001).toBeGreaterThan(3);
    expect(perTicketPayout(10_001, 3) - 10_001).toBe(1);
  });

  // The general shape, measured rather than asserted-and-hoped: across the
  // generated orders, splitting a cancellation into single tickets really does
  // overshoot sometimes, and never by more than half a cent per ticket.
  //
  // The overshoot is accumulated in BigInt, not in doubles. `refund * tickets`
  // is exactly the product the source went to BigInt to avoid, and computing it
  // in floating point makes the TEST wrong at the top of the admitted range:
  // for {totalCents: 9007199254740990, tickets: 11} the per-ticket share is
  // 818836295885545, and 818836295885545 * 11 is 9007199254740995 exactly but
  // 9007199254740996 in a double — a phantom extra cent of overshoot that
  // breaks the tickets/2 bound the source actually honours. An oracle that
  // rounds cannot audit arithmetic that does not.
  it("piecemeal cancellation overshoots on a real share of generated orders, and never by more than half a cent per ticket", () => {
    const orders = fc.sample(orderArb(payingCentsArb), 5_000).filter((o) => o.tickets <= 200);
    let overshooting = 0;
    let atTopOfRange = 0;
    for (const order of orders) {
      const share = calculateRefund(order, 1, previousDouble(order.eventStartMs));
      const overshoot = BigInt(share) * BigInt(order.tickets) - BigInt(order.totalCents);
      // overshoot <= tickets / 2, in integers: 2 * overshoot <= tickets.
      expect(2n * overshoot <= BigInt(order.tickets)).toBe(true);
      if (overshoot > 0n) overshooting++;
      if (order.totalCents > Number.MAX_SAFE_INTEGER / 2) atTopOfRange++;
    }
    expect(orders.length).toBeGreaterThan(1_000);
    expect(overshooting).toBeGreaterThan(orders.length * 0.05);
    // The bound is checked where doubles would have lied about it, not only in
    // the comfortable range.
    expect(atTopOfRange).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Generator census.
//
// A green property is worth exactly what its generator produced. These sample
// the arbitraries the properties above consume and assert the measurements, so
// a future edit that narrows a generator fails here instead of silently turning
// the properties into decoration.
// ---------------------------------------------------------------------------
describe("generator census — the properties above see the ugly cases", () => {
  const SAMPLES = 5_000;

  it("the open-window clock is always strictly before the start, including one ULP before", () => {
    const start = 1_700_000_000_000;
    const clocks = fc.sample(before(start), SAMPLES);
    expect(clocks.every((t) => Number.isFinite(t) && t < start)).toBe(true);
    expect(clocks.filter((t) => t === previousDouble(start)).length).toBeGreaterThan(0);
    expect(clocks.filter((t) => start - t > 86_400_000).length).toBeGreaterThan(0);
  });

  it("event starts reach the epoch, negative time, fractional milliseconds and MAX_SAFE_INTEGER", () => {
    const starts = fc.sample(startArb, SAMPLES);
    expect(starts.every(Number.isFinite)).toBe(true);
    expect(starts.filter((s) => s === 0).length).toBeGreaterThan(0);
    expect(starts.filter((s) => s < 0).length).toBeGreaterThan(SAMPLES * 0.05);
    expect(starts.filter((s) => !Number.isInteger(s)).length).toBeGreaterThan(0);
    expect(starts.filter((s) => Math.abs(s) === Number.MAX_SAFE_INTEGER).length).toBeGreaterThan(0);
  });

  it("the cases under test reach zero-cost orders, one-cent orders, the fee cliff and the top of the range", () => {
    const cases = fc.sample(anyCase, SAMPLES);
    const cents = cases.map((c) => c.order.totalCents);
    expect(cents.filter((c) => c === 0).length).toBeGreaterThan(0);
    expect(cents.filter((c) => c === 1).length).toBeGreaterThan(0);
    expect(cents.filter((c) => c > 0 && c <= 50).length).toBeGreaterThan(SAMPLES * 0.02);
    expect(cents.filter((c) => c > Number.MAX_SAFE_INTEGER / 2).length).toBeGreaterThan(0);
    expect(cents.every((c) => Number.isInteger(c) && c >= 0 && c <= Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("the cases under test reach 100% discounts, single tickets, big blocks and totals that do not divide", () => {
    const cases = fc.sample(anyCase, SAMPLES);
    const orders = cases.map((c) => c.order);
    expect(orders.filter((o) => o.discountPercent === 100).length).toBeGreaterThan(0);
    expect(orders.filter((o) => !Number.isInteger(o.discountPercent)).length).toBeGreaterThan(0);
    expect(orders.filter((o) => o.tickets === 1).length).toBeGreaterThan(0);
    expect(orders.filter((o) => o.tickets > 100).length).toBeGreaterThan(SAMPLES * 0.05);
    expect(orders.filter((o) => o.tickets > 1 && o.totalCents % o.tickets !== 0).length).toBeGreaterThan(
      SAMPLES * 0.2,
    );
    expect(orders.filter((o) => o.totalCents > 0 && o.totalCents < o.tickets).length).toBeGreaterThan(0);
  });

  it("the cases under test cancel nothing, one ticket, and the whole order", () => {
    const cases = fc.sample(anyCase, SAMPLES);
    expect(cases.every((c) => Number.isInteger(c.cancelled) && c.cancelled >= 0 && c.cancelled <= c.order.tickets))
      .toBe(true);
    expect(cases.filter((c) => c.cancelled === 0).length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.cancelled === 1).length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.cancelled === c.order.tickets).length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.cancelled > 0 && c.cancelled < c.order.tickets).length).toBeGreaterThan(
      SAMPLES * 0.1,
    );
  });

  it("the paying cases always cost something and always cancel something", () => {
    const cases = fc.sample(payingCase, SAMPLES);
    expect(cases.every((c) => c.order.totalCents >= 1)).toBe(true);
    expect(cases.every((c) => c.cancelled >= 1)).toBe(true);
    expect(cases.filter((c) => c.order.totalCents === 1).length).toBeGreaterThan(0);
  });
});
