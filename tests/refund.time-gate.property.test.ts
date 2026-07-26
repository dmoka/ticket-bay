// Property-based suite for the ONE promise in src/refund.ts that no other test
// in this repo ever exercises: the refund window closes when the event starts.
//
// src/refund.ts:8   "when the event starts, ms since epoch — refunds close at
//                    this moment"
// src/refund.ts:16  "Business rule: cancellations are only allowed BEFORE the
//                    event starts. From `eventStartMs` on, the refund is zero."
//
// The docstrings in src/ ARE the specification, so that is a rule the code owes
// the reader, not a comment. Every existing property file builds its clock with
// a `strictlyBefore(...)` helper and never once asks what happens at or after
// `eventStartMs` — which is why 142 green tests and a 95.60% mutation score say
// nothing at all about this rule. A mutation score measures the code that
// exists; it cannot score a branch that was never written.
//
// Nothing here re-derives the implementation's arithmetic. Each property is
// stated in English above the code that encodes it, and each is something a
// customer or a finance team would recognise as true without reading any
// TypeScript.
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

/** `start - delta`, guaranteed strictly earlier than `start`. */
function strictlyBefore(start: number, delta: number): number {
  const candidate = start - delta;
  return candidate < start ? candidate : previousDouble(start);
}

/** `start + delta`, guaranteed strictly later than `start`. */
function strictlyAfter(start: number, delta: number): number {
  const candidate = start + delta;
  return candidate > start ? candidate : nextDouble(start);
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

/**
 * A clock reading at or after the event start — the window the docstring says is
 * closed. Includes the boundary instant itself, the very next representable
 * instant, sub-millisecond deltas, and clocks years later.
 */
const atOrAfter = (start: number): fc.Arbitrary<number> =>
  fc.oneof(
    { weight: 3, arbitrary: fc.constant(start) },
    { weight: 2, arbitrary: fc.constant(nextDouble(start)) },
    { weight: 3, arbitrary: fc.integer({ min: 1, max: 10_000_000_000 }).map((d) => strictlyAfter(start, d)) },
    {
      weight: 2,
      arbitrary: fc.double({ min: Number.MIN_VALUE, max: 1, noNaN: true }).map((d) => strictlyAfter(start, d)),
    },
    {
      weight: 1,
      arbitrary: fc
        .constantFrom(4_000_000_000_000, 1e15, Number.MAX_SAFE_INTEGER, 1e300)
        .map((t) => (t > start ? t : nextDouble(start))),
    },
  );

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
  closed: number;
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
      closed: atOrAfter(order.eventStartMs),
      open: before(order.eventStartMs),
    }),
  );

/** Any order, any cancellation. */
const anyCase = gateCase();
/** Orders that cost real money, cancellations that cancel at least one ticket. */
const payingCase = gateCase(payingCentsArb, 1);

const RUNS = { numRuns: 3000 } as const;

// ---------------------------------------------------------------------------
// The closed side of the window.
// ---------------------------------------------------------------------------
describe("the refund window is closed from the moment the event starts", () => {
  // INVARIANT: from `eventStartMs` onwards not one cent leaves the platform. A
  // cancellation after the show has begun is a customer asking for their money
  // back for a concert that already happened; the business rule says no.
  //
  // This is stated as "never pays", not "returns zero", so an implementation
  // that refuses the call outright also satisfies it. It is the money-safety
  // form of the rule and the weakest thing that can honestly be called correct.
  it("never pays out a cent once the event has started", () => {
    fc.assert(
      fc.property(anyCase, ({ order, cancelled, closed }) => {
        for (const pay of [calculateRefund, netRefund]) {
          let paid: number;
          try {
            paid = pay(order, cancelled, closed);
          } catch (refusal) {
            expect(refusal).toBeInstanceOf(RangeError);
            continue;
          }
          expect(paid).toBe(0);
        }
      }),
      RUNS,
    );
  });

  // INVARIANT (the literal promise at src/refund.ts:17, "From `eventStartMs` on,
  // the refund is zero"): asking after the start is a legitimate question with
  // the answer nought, not a malformed input. It returns 0; it does not throw.
  it("returns exactly zero, rather than refusing, once the event has started", () => {
    fc.assert(
      fc.property(anyCase, ({ order, cancelled, closed }) => {
        expect(calculateRefund(order, cancelled, closed)).toBe(0);
        expect(netRefund(order, cancelled, closed)).toBe(0);
      }),
      RUNS,
    );
  });

  // INVARIANT: the closed window does not care how big the order was. The rule
  // is about the clock, so an expensive order and a one-cent order are refused
  // alike — no threshold under which a late refund quietly still pays.
  it("closes for every size of order alike", () => {
    fc.assert(
      fc.property(payingCase, ({ order, cancelled, closed }) => {
        expect(calculateRefund(order, cancelled, closed)).toBe(0);
        const cheap: Order = { ...order, totalCents: 1 };
        const dear: Order = { ...order, totalCents: Number.MAX_SAFE_INTEGER };
        expect(calculateRefund(cheap, cancelled, closed)).toBe(0);
        expect(calculateRefund(dear, cancelled, closed)).toBe(0);
      }),
      RUNS,
    );
  });

  // INVARIANT: after the start the platform keeps nothing either. A closed
  // window is not a fee-collection opportunity: gross zero, fee zero, net zero,
  // and money still balances across the gate.
  it("keeps no fee on a refund the window has closed on", () => {
    fc.assert(
      fc.property(payingCase, ({ order, cancelled, closed }) => {
        const gross = calculateRefund(order, cancelled, closed);
        const net = netRefund(order, cancelled, closed);
        expect(net + refundFee(gross)).toBe(gross);
        expect(refundFee(gross)).toBe(0);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// The open side — anti-vacuity.
//
// Every property above is satisfied by a `calculateRefund` that returns 0 for
// everything. These are the ones that make that fix illegal.
// ---------------------------------------------------------------------------
describe("the refund window is open until the event starts", () => {
  // INVARIANT: before the event, cancelling every ticket of an order that cost
  // money returns that money — in full, to the cent. The gate must not close
  // early, and it must not close on the whole feature.
  it("still refunds the full amount right up until the start", () => {
    fc.assert(
      fc.property(payingCase, ({ order, open }) => {
        expect(calculateRefund(order, order.tickets, open)).toBe(order.totalCents);
        expect(calculateRefund(order, order.tickets, open)).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });

  // INVARIANT: the boundary is exactly `eventStartMs` and it is inclusive —
  // "from `eventStartMs` on". The last representable instant before the start
  // still pays in full; the start itself pays nothing. Two adjacent doubles,
  // opposite answers: this pins the gate to the documented instant rather than
  // to some millisecond either side of it.
  it("pays in full one instant before the start and nothing at the start itself", () => {
    fc.assert(
      fc.property(payingCase, ({ order }) => {
        const lastOpen = previousDouble(order.eventStartMs);
        expect(calculateRefund(order, order.tickets, lastOpen)).toBe(order.totalCents);
        expect(calculateRefund(order, order.tickets, order.eventStartMs)).toBe(0);
        expect(calculateRefund(order, order.tickets, nextDouble(order.eventStartMs))).toBe(0);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// The gate as a function of time.
// ---------------------------------------------------------------------------
describe("the gate only ever closes, never reopens", () => {
  // INVARIANT: waiting never gets you a bigger refund. Read on two clocks, the
  // later one never pays more than the earlier one — the window shuts once and
  // stays shut.
  it("a later clock never pays more than an earlier one", () => {
    fc.assert(
      fc.property(anyCase, fc.double({ min: 0, max: 1e13, noNaN: true }), ({ order, cancelled, open }, gap) => {
        const later = open + gap;
        if (!Number.isFinite(later) || later < open) return;
        expect(calculateRefund(order, cancelled, later)).toBeLessThanOrEqual(
          calculateRefund(order, cancelled, open),
        );
      }),
      RUNS,
    );
  });

  // INVARIANT: the answer depends on the clock only through "has the event
  // started yet". Any two open clocks agree with each other, and any two closed
  // clocks agree with each other — the amount never drifts within a window.
  it("all open clocks agree, and all closed clocks agree", () => {
    fc.assert(
      fc.property(anyCase, anyCase, (a, b) => {
        const order = a.order;
        const cancelled = Math.min(a.cancelled, order.tickets);
        const otherOpen = strictlyBefore(order.eventStartMs, 1 + Math.abs(b.open % 1_000_000));
        expect(calculateRefund(order, cancelled, otherOpen)).toBe(calculateRefund(order, cancelled, a.open));
        const otherClosed = strictlyAfter(order.eventStartMs, 1 + Math.abs(b.closed % 1_000_000));
        expect(calculateRefund(order, cancelled, otherClosed)).toBe(calculateRefund(order, cancelled, a.closed));
      }),
      RUNS,
    );
  });

  // INVARIANT: the gate must not swallow the clock validation. An unreadable
  // clock is still refused after the gate exists — a `nowMs >= eventStartMs`
  // test placed above the `Number.isFinite` guard would turn NaN into a silent
  // zero, and a broken clock reading as "the event has started" is the same
  // class of bug as a broken clock reading as "refund it all".
  it("still refuses an unreadable clock rather than treating it as late", () => {
    fc.assert(
      fc.property(anyCase, fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY), (
        { order, cancelled },
        broken,
      ) => {
        expect(() => calculateRefund(order, cancelled, broken)).toThrow(RangeError);
        expect(() => netRefund(order, cancelled, broken)).toThrow(RangeError);
      }),
      RUNS,
    );
  });

  // INVARIANT: the gate does not override input validation either. A
  // cancellation count the order cannot support is still refused, whether or
  // not the event has started — a late call must not launder a bad request into
  // a tidy zero.
  it("still refuses an impossible cancellation count after the start", () => {
    fc.assert(
      fc.property(anyCase, fc.integer({ min: 1, max: 1_000 }), ({ order, closed }, extra) => {
        expect(() => calculateRefund(order, order.tickets + extra, closed)).toThrow(RangeError);
        expect(() => calculateRefund(order, -extra, closed)).toThrow(RangeError);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Booking feeds the gate.
// ---------------------------------------------------------------------------
describe("an order for an event that has already started refunds nothing", () => {
  const eventArb: fc.Arbitrary<Event> = fc
    .record({
      totalSeats: fc.integer({ min: 1, max: 5_000 }),
      priceCents: fc.oneof(fc.constantFrom(1, 2, 99, 5_000), fc.integer({ min: 1, max: 10_000_000 })),
      startMs: startArb,
    })
    .chain(({ totalSeats, priceCents, startMs }) =>
      fc
        .integer({ min: 0, max: totalSeats - 1 })
        .map((seatsSold) => ({ id: "e1", name: "RockFest", totalSeats, seatsSold, priceCents, startMs })),
    );

  // INVARIANT: `bookTickets` has no clock and cannot refuse a sale for an event
  // that already began, so the refund path is the only place the rule can live.
  // Whatever booking sells, cancelling it after the start returns nothing.
  it("a booked order cancelled after its event started returns nothing", () => {
    fc.assert(
      fc.property(
        eventArb,
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (ev, want, discount, lateBy) => {
          const n = Math.min(want, ev.totalSeats - ev.seatsSold);
          fc.pre(n >= 1);
          const order = bookTickets(ev, n, discount);
          const late = strictlyAfter(order.eventStartMs, lateBy);
          expect(calculateRefund(order, order.tickets, late)).toBe(0);
          expect(netRefund(order, order.tickets, late)).toBe(0);
        },
      ),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Deterministic pins for the minimal counterexamples, so the failures are
// reproducible without a fast-check seed.
// ---------------------------------------------------------------------------
describe("minimal counterexamples for the closed window", () => {
  it("a one-cent, one-ticket order at the epoch refunds nothing at the epoch", () => {
    const order: Order = { totalCents: 1, tickets: 1, discountPercent: 0, eventStartMs: 0 };
    expect(calculateRefund(order, 1, 0)).toBe(0);
  });

  it("a €100 order refunds nothing at the instant the event starts", () => {
    const start = 1_700_000_000_000;
    const order: Order = { totalCents: 10_000, tickets: 4, discountPercent: 0, eventStartMs: start };
    expect(calculateRefund(order, 4, start)).toBe(0);
    expect(netRefund(order, 4, start)).toBe(0);
  });

  it("a €100 order refunds nothing a day after the event started", () => {
    const start = 1_700_000_000_000;
    const order: Order = { totalCents: 10_000, tickets: 4, discountPercent: 0, eventStartMs: start };
    expect(calculateRefund(order, 4, start + 86_400_000)).toBe(0);
    expect(netRefund(order, 4, start + 86_400_000)).toBe(0);
  });

  it("still refunds in full at the last representable instant before the start", () => {
    const start = 1_700_000_000_000;
    const order: Order = { totalCents: 10_000, tickets: 4, discountPercent: 0, eventStartMs: start };
    expect(calculateRefund(order, 4, previousDouble(start))).toBe(10_000);
  });
});

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

  it("the closed-window clock is always at or after the start, and reaches the boundary and one ULP past it", () => {
    const start = 1_700_000_000_000;
    const clocks = fc.sample(atOrAfter(start), SAMPLES);
    expect(clocks.every((t) => Number.isFinite(t) && t >= start)).toBe(true);
    expect(clocks.filter((t) => t === start).length).toBeGreaterThan(SAMPLES * 0.1);
    expect(clocks.filter((t) => t === nextDouble(start)).length).toBeGreaterThan(0);
    expect(clocks.filter((t) => t > start && t - start < 1).length).toBeGreaterThan(0);
    expect(clocks.filter((t) => t - start > 86_400_000).length).toBeGreaterThan(SAMPLES * 0.05);
  });

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
    expect(cases.filter((c) => c.closed === c.order.eventStartMs).length).toBeGreaterThan(SAMPLES * 0.1);
  });
});
