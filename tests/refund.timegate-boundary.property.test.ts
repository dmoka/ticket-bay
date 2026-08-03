// Round-2 property suite: where the refund window actually closes, and what the
// platform keeps once it has.
//
// tests/refund.timegate.property.test.ts (round 1) established that the window
// closes. Three of its properties — clock monotonicity, one-answer-per-side, and
// no-double-payout — could not fail at the time, because the refund ignored the
// clock entirely and every clock gave the same answer. They are live now, and an
// over-correction hides in exactly that space: a gate that fires a moment early,
// a gate that swallowed the validation above it, or a fee guard that quietly
// moved a real cent amount.
//
// So these properties do not assume where the boundary is. Where it matters they
// SEARCH the double line for the instant at which the answer changes and assert
// that instant is the event start — an off-by-one-ULP gate, a `>` instead of a
// `>=`, or a grace period of any size all come back as a located counterexample.
//
// Every invariant is stated in English above the property that encodes it, and
// every invariant is a rule about money or about the published contract in
// src/refund.ts — never a restatement of the arithmetic in it.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { calculateRefund, netRefund, refundFee, Order } from "../src/refund";
import { bookTickets, Event } from "../src/booking";

// ---------------------------------------------------------------------------
// Walking the double line
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

/**
 * A strictly increasing map from double to integer, so the instants between two
 * clock readings can be bisected. Every representable instant gets its own
 * index; `-0` and `0` share one, which is right — they are the same instant.
 */
function clockIndex(t: number): bigint {
  f64[0] = Math.abs(t);
  const magnitude = i64[0];
  return t < 0 ? -magnitude : magnitude;
}

function clockAt(index: bigint): number {
  i64[0] = index < 0n ? -index : index;
  const magnitude = f64[0];
  return index < 0n ? -magnitude : magnitude;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Money an order can hold, from a free order to the top of the admitted range. */
const centsArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(0, 1, 2, 49, 50, 51, 99, 100, 2475, 2525, 9999, 10_000) },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 1_000_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 1_000_000_000_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: Number.MAX_SAFE_INTEGER - 10_000, max: Number.MAX_SAFE_INTEGER }) },
);

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

/**
 * Event starts spread across every magnitude a double can hold a time in: the
 * epoch, the instant either side of it, sub-millisecond times, negative time,
 * today, and a date long past the end of the platform. Deliberately stops short
 * of ±Number.MAX_VALUE so the instants either side of a start stay readable —
 * the clock validator refuses ±Infinity, and that is a separate rule.
 */
const startArb = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      0,
      1,
      -1,
      1.5,
      -1.5,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      Number.EPSILON,
      1e-300,
      1_700_000_000_000,
      4_000_000_000_000,
      1e15,
      -1e15,
    ),
  },
  { weight: 4, arbitrary: fc.integer({ min: -1_000_000_000_000, max: 4_000_000_000_000 }) },
  { weight: 1, arbitrary: fc.double({ min: -1e15, max: 1e15, noNaN: true }) },
);

const orderArb: fc.Arbitrary<Order> = fc.record({
  totalCents: centsArb,
  tickets: ticketsArb,
  discountPercent: discountArb,
  eventStartMs: startArb,
});

/** Distances in time, from one ULP to a century. */
const gapArb = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom(0, 1, 2, 1_000, 60_000, 3_600_000, 86_400_000, 31_536_000_000, 3_153_600_000_000),
  },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 4_000_000_000_000 }) },
  { weight: 1, arbitrary: fc.double({ min: 0, max: 1, noNaN: true }) },
);

/** A readable clock strictly before `start`; `0` means the last instant before it. */
function before(start: number, gap: number): number {
  const candidate = start - gap;
  return candidate < start && Number.isFinite(candidate) ? candidate : previousDouble(start);
}

/** A readable clock at or after `start`; `0` means the start instant itself. */
function atOrAfter(start: number, gap: number): number {
  if (gap === 0) return start;
  const candidate = start + gap;
  return candidate > start && Number.isFinite(candidate) ? candidate : nextDouble(start);
}

const RUNS = { numRuns: 2000 } as const;
const SEARCH_RUNS = { numRuns: 400 } as const;

// ---------------------------------------------------------------------------
// Where the boundary actually is — found, not assumed
// ---------------------------------------------------------------------------

/** An order whose refund is real money while the window is open. */
const payingCase = fc
  .record({
    totalCents: centsArb.filter((c) => c > 0),
    tickets: ticketsArb,
    discountPercent: discountArb,
    eventStartMs: startArb,
  })
  .chain((order) =>
    fc.record({
      order: fc.constant(order),
      cancelled: fc.integer({ min: 1, max: order.tickets }),
    }),
  );

/**
 * The earliest instant at which the refund becomes zero, located by bisecting
 * the representable clock readings between a clock long before the event and one
 * long after it. Nothing here knows what the answer should be.
 */
function firstInstantThatRefusesToPay(order: Order, cancelled: number): number {
  let paying = clockIndex(-1e308);
  let refusing = clockIndex(1e308);
  let steps = 0;
  while (refusing - paying > 1n) {
    const middle = paying + (refusing - paying) / 2n;
    if (calculateRefund(order, cancelled, clockAt(middle)) === 0) refusing = middle;
    else paying = middle;
    if (++steps > 200) throw new Error("bisection did not converge");
  }
  return clockAt(refusing);
}

describe("calculateRefund — where the refund window closes", () => {
  // INVARIANT: the refund window closes at the event start and at no other
  // instant. Search every representable clock reading from long before the event
  // to long after it for the first one that refuses to pay: it is exactly
  // `eventStartMs`. One ULP earlier is a window that closes early and robs a
  // customer who cancelled in time; one ULP later is a window that pays after
  // the event has begun.
  it("the first instant that refuses a refund is the event start itself", () => {
    // `0` and `-0` name the same instant. The boundary is compared as a time,
    // not as a bit pattern — `Object.is` separates the two, a clock does not.
    const asTime = (t: number) => (t === 0 ? 0 : t);
    fc.assert(
      fc.property(payingCase, ({ order, cancelled }) => {
        const open = calculateRefund(order, cancelled, previousDouble(order.eventStartMs));
        fc.pre(open > 0);
        expect(asTime(firstInstantThatRefusesToPay(order, cancelled))).toBe(asTime(order.eventStartMs));
      }),
      SEARCH_RUNS,
    );
  });

  // INVARIANT: that instant is a real cliff, not a dip. The last readable moment
  // before the event still buys the whole share back; the event start itself
  // buys nothing.
  it("pays the full share one instant before the start and nothing at the start", () => {
    fc.assert(
      fc.property(payingCase, ({ order, cancelled }) => {
        const justBefore = previousDouble(order.eventStartMs);
        expect(calculateRefund(order, cancelled, justBefore)).toBeGreaterThanOrEqual(0);
        expect(calculateRefund(order, order.tickets, justBefore)).toBe(order.totalCents);
        expect(calculateRefund(order, cancelled, order.eventStartMs)).toBe(0);
        expect(calculateRefund(order, cancelled, nextDouble(order.eventStartMs))).toBe(0);
      }),
      RUNS,
    );
  });

  // INVARIANT: the window does not close early. A customer who cancels before
  // the event gets the same refund whether they cancel a century early, a day
  // early or one ULP early — there is no run-up during which the platform has
  // quietly stopped paying.
  it("pays the same at every instant before the start, from one ULP early to a century early", () => {
    fc.assert(
      fc.property(
        payingCase.chain(({ order, cancelled }) =>
          fc.record({
            order: fc.constant(order),
            cancelled: fc.constant(cancelled),
            gaps: fc.array(gapArb, { minLength: 2, maxLength: 8 }),
          }),
        ),
        ({ order, cancelled, gaps }) => {
          const reference = calculateRefund(order, cancelled, previousDouble(order.eventStartMs));
          for (const gap of gaps) {
            expect(calculateRefund(order, cancelled, before(order.eventStartMs, gap))).toBe(reference);
          }
        },
      ),
      RUNS,
    );
  });

  // INVARIANT: the clock is a switch, not a dial. Across any set of readable
  // clock readings the refund takes at most two values — the full share while
  // the window is open, and nothing once it has closed. Nothing in between, and
  // no third amount at any distance from the event.
  it("takes only two values across the whole clock: the share, and nothing", () => {
    fc.assert(
      fc.property(
        payingCase.chain(({ order, cancelled }) =>
          fc.record({
            order: fc.constant(order),
            cancelled: fc.constant(cancelled),
            clocks: fc.array(
              fc.oneof(
                gapArb.map((g) => before(order.eventStartMs, g)),
                gapArb.map((g) => atOrAfter(order.eventStartMs, g)),
                fc.double({ min: -1e15, max: 1e15, noNaN: true }),
              ),
              { minLength: 3, maxLength: 12 },
            ),
          }),
        ),
        ({ order, cancelled, clocks }) => {
          const open = calculateRefund(order, cancelled, previousDouble(order.eventStartMs));
          const seen = new Set(clocks.map((t) => calculateRefund(order, cancelled, t)));
          expect(seen.size).toBeLessThanOrEqual(2);
          for (const value of seen) expect([0, open]).toContain(value);
        },
      ),
      RUNS,
    );
  });

  // INVARIANT: waiting never pays better, and when waiting costs the customer
  // money it is the event that took it. If a later clock refunds less than an
  // earlier one, the earlier reading was before the event start and the later
  // one was not — the drop cannot be blamed on anything else about the clock.
  it("only ever pays less on a later clock, and only across the event start", () => {
    fc.assert(
      fc.property(
        orderArb.chain((order) =>
          fc.record({
            order: fc.constant(order),
            cancelled: fc.integer({ min: 0, max: order.tickets }),
            a: fc.oneof(
              gapArb.map((g) => before(order.eventStartMs, g)),
              gapArb.map((g) => atOrAfter(order.eventStartMs, g)),
              fc.double({ min: -1e15, max: 1e15, noNaN: true }),
            ),
            b: fc.oneof(
              gapArb.map((g) => before(order.eventStartMs, g)),
              gapArb.map((g) => atOrAfter(order.eventStartMs, g)),
              fc.double({ min: -1e15, max: 1e15, noNaN: true }),
            ),
          }),
        ),
        ({ order, cancelled, a, b }) => {
          const [earlier, later] = a <= b ? [a, b] : [b, a];
          const paidEarlier = calculateRefund(order, cancelled, earlier);
          const paidLater = calculateRefund(order, cancelled, later);
          expect(paidLater).toBeLessThanOrEqual(paidEarlier);
          if (paidLater < paidEarlier) {
            expect(earlier).toBeLessThan(order.eventStartMs);
            expect(later).toBeGreaterThanOrEqual(order.eventStartMs);
          }
        },
      ),
      RUNS,
    );
  });

  // INVARIANT: the same one-way door on the money that actually leaves the
  // platform. What the customer is handed never grows as the clock advances.
  it("never hands the customer more on a later clock than on an earlier one", () => {
    fc.assert(
      fc.property(
        orderArb.chain((order) =>
          fc.record({
            order: fc.constant(order),
            cancelled: fc.integer({ min: 0, max: order.tickets }),
            a: gapArb.map((g) => before(order.eventStartMs, g)),
            b: gapArb.map((g) => atOrAfter(order.eventStartMs, g)),
          }),
        ),
        ({ order, cancelled, a, b }) => {
          expect(netRefund(order, cancelled, b)).toBeLessThanOrEqual(netRefund(order, cancelled, a));
        },
      ),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// A closed window closes the money — and nothing else
// ---------------------------------------------------------------------------
describe("calculateRefund — a closed window is not a shortcut", () => {
  // INVARIANT (src/refund.ts:53-54): a closed window closes the money, it does
  // not excuse a bad call. Every order and cancellation the refund path refuses
  // while the window is open, it refuses just the same after the event — a gate
  // placed above the validation would silently answer "nothing owed" to a call
  // that asked for a negative number of tickets.
  it("refuses a bad call after the event exactly as it does before it", () => {
    const invalidCall = fc.oneof(
      fc.record({
        order: orderArb,
        cancelled: fc.oneof(fc.integer({ min: -1_000_000, max: -1 }), fc.constant(-1), fc.constant(-0.5)),
      }),
      orderArb.chain((order) => fc.record({ order: fc.constant(order), cancelled: fc.constant(order.tickets + 1) })),
      fc.record({
        order: orderArb,
        // A fraction of a ticket is not a ticket, whatever the order holds.
        cancelled: fc.constantFrom(0.5, 1.5, 2.25, Number.MIN_VALUE, Number.NaN, Number.POSITIVE_INFINITY),
      }),
      fc.record({
        order: orderArb.map((o) => ({ ...o, tickets: 0 })),
        cancelled: fc.constant(0),
      }),
      fc.record({
        order: orderArb.map((o) => ({ ...o, discountPercent: 101 })),
        cancelled: fc.constant(0),
      }),
      fc.record({
        order: orderArb.map((o) => ({ ...o, discountPercent: Number.NaN })),
        cancelled: fc.constant(0),
      }),
      fc.record({
        order: orderArb.map((o) => ({ ...o, totalCents: -1 })),
        cancelled: fc.constant(0),
      }),
      fc.record({
        order: orderArb.map((o) => ({ ...o, totalCents: Number.MAX_SAFE_INTEGER + 2 })),
        cancelled: fc.constant(0),
      }),
      fc.record({
        order: orderArb.map((o) => ({ ...o, eventStartMs: Number.NaN })),
        cancelled: fc.constant(0),
      }),
    );

    fc.assert(
      fc.property(invalidCall, gapArb, gapArb, ({ order, cancelled }, earlyGap, lateGap) => {
        // Whatever the clock says, an unbookable call is an unbookable call.
        const clocks = Number.isFinite(order.eventStartMs)
          ? [before(order.eventStartMs, earlyGap), atOrAfter(order.eventStartMs, lateGap), order.eventStartMs]
          : [0, 1_700_000_000_000];
        for (const now of clocks) {
          expect(() => calculateRefund(order, cancelled, now)).toThrow(RangeError);
          expect(() => netRefund(order, cancelled, now)).toThrow(RangeError);
        }
      }),
      RUNS,
    );
  });

  // INVARIANT (src/refund.ts:45-46): an absent or broken clock must never fall
  // through to a payout. A reading that is not a real instant is refused; it
  // never quietly pays, and it never quietly counts as "the event has started".
  it("never pays on a clock that is not a real instant", () => {
    fc.assert(
      fc.property(
        orderArb,
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        (order, broken) => {
          let paid: number;
          try {
            paid = calculateRefund(order, order.tickets, broken);
          } catch (e) {
            expect(e).toBeInstanceOf(RangeError);
            return;
          }
          expect(paid).toBe(0);
        },
      ),
      RUNS,
    );
  });

  // INVARIANT: once the window has closed nobody is paid — not the customer, and
  // not the platform. The gate sits above the fee (src/refund.ts:52-53), so a
  // refused refund earns no fee revenue either: gross, fee and net are all zero.
  it("earns the platform nothing once the window has closed", () => {
    fc.assert(
      fc.property(
        orderArb.chain((order) =>
          fc.record({
            order: fc.constant(order),
            cancelled: fc.integer({ min: 0, max: order.tickets }),
            late: gapArb.map((g) => atOrAfter(order.eventStartMs, g)),
          }),
        ),
        ({ order, cancelled, late }) => {
          const gross = calculateRefund(order, cancelled, late);
          expect(gross).toBe(0);
          expect(refundFee(gross)).toBe(0);
          expect(netRefund(order, cancelled, late)).toBe(0);
        },
      ),
      RUNS,
    );
  });

  // INVARIANT: the gate belongs to the orders the platform actually issues, not
  // just to hand-built ones. Every order `bookTickets` sells refunds in full up
  // to the instant its event starts and nothing from that instant on.
  it("holds for orders the booking path actually sells", () => {
    fc.assert(
      fc.property(
        fc.record({
          totalSeats: fc.integer({ min: 1, max: 5_000 }),
          priceCents: fc.oneof(fc.constantFrom(0, 1, 49, 50, 2525, 999_999), fc.integer({ min: 0, max: 1_000_000 })),
          startMs: startArb,
          n: fc.integer({ min: 1, max: 5_000 }),
          discount: fc.constantFrom(0, 5, 10, 100),
        }),
        ({ totalSeats, priceCents, startMs, n, discount }) => {
          const ev: Event = { id: "e", name: "e", totalSeats, seatsSold: 0, priceCents, startMs };
          let order: Order;
          try {
            order = bookTickets(ev, n, discount);
          } catch (e) {
            expect(e).toBeInstanceOf(RangeError);
            return;
          }
          expect(calculateRefund(order, order.tickets, previousDouble(startMs))).toBe(order.totalCents);
          expect(calculateRefund(order, order.tickets, startMs)).toBe(0);
          expect(netRefund(order, order.tickets, startMs)).toBe(0);
        },
      ),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// The fee guard, on amounts that are real money
// ---------------------------------------------------------------------------

/** Whole cents across the range a refund can actually be. */
const wholeCentsArb = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(0, 1, 2, 25, 49, 50, 51, 52, 99, 100, 2474, 2475, 2499, 2500, 2524, 2525, 2526, 2550),
  },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 10_000 }) },
  { weight: 3, arbitrary: fc.integer({ min: 0, max: 1_000_000_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }) },
  { weight: 1, arbitrary: fc.integer({ min: Number.MAX_SAFE_INTEGER - 1_000, max: Number.MAX_SAFE_INTEGER }) },
);

/** Anything finite the function will accept, real cents or not. */
const anyFiniteAmountArb = fc.oneof(
  { weight: 4, arbitrary: wholeCentsArb },
  { weight: 2, arbitrary: fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      -0,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      Number.EPSILON,
      1e-300,
      49.5,
      50.5,
      2524.9,
      2525.1,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      -1,
      -1e300,
    ),
  },
);

describe("refundFee — the guard did not move a real cent amount", () => {
  // INVARIANT: refusing a broken amount must not have made the function refuse a
  // real one. Every finite amount still produces a finite fee — never NaN, never
  // Infinity, never a missing answer.
  it("turns every finite amount into a finite fee", () => {
    fc.assert(
      fc.property(anyFiniteAmountArb, (amount) => {
        const fee = refundFee(amount);
        expect(Number.isFinite(fee)).toBe(true);
      }),
      RUNS,
    );
  });

  // INVARIANT: cancelling a ticket never bills the customer. The platform's cut
  // is never negative and never larger than the refund it is taken from, so a
  // refund can be swallowed whole but can never turn into a debt.
  it("never keeps a negative amount and never keeps more than the refund", () => {
    fc.assert(
      fc.property(anyFiniteAmountArb, (amount) => {
        const fee = refundFee(amount);
        expect(fee).toBeGreaterThanOrEqual(0);
        expect(fee).toBeLessThanOrEqual(Math.max(0, amount));
      }),
      RUNS,
    );
  });

  // INVARIANT (src/refund.ts:79 — "Min 50, 2% of refund"): the minimum is really
  // collected. On any refund the platform keeps at least 50 cents, or the whole
  // refund when the refund is smaller than the minimum.
  it("always collects the minimum, or the whole refund when that is smaller", () => {
    fc.assert(
      fc.property(anyFiniteAmountArb, (amount) => {
        if (amount <= 0) {
          expect(refundFee(amount)).toBe(0);
          return;
        }
        expect(refundFee(amount)).toBeGreaterThanOrEqual(Math.min(50, amount));
      }),
      RUNS,
    );
  });

  // INVARIANT (same docstring): below the point where 2% overtakes the minimum
  // the schedule is flat. On any refund up to €25 the platform keeps the 50-cent
  // minimum and not a cent more — or the whole refund, when the refund is
  // smaller than the minimum.
  it("keeps the flat minimum, and only the minimum, below the crossover", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2_500 }), (amount) => {
        expect(refundFee(amount)).toBe(Math.min(50, amount));
      }),
      RUNS,
    );
  });

  // INVARIANT (same docstring): above the crossover the platform keeps the
  // published rate — 2% of the refund, rounded to a whole cent. So its cut is
  // never more than half a cent away from 2%, in either direction: a schedule
  // that always rounded the platform's way would take a whole cent more than the
  // rate on half of all refunds. `amount / 50` is that 2% arrived at
  // independently of the source, and half a cent is the most that rounding to
  // whole cents can honestly move it.
  it("keeps 2% to within half a cent above the crossover", () => {
    fc.assert(
      fc.property(wholeCentsArb.filter((c) => c >= 2_500), (amount) => {
        expect(Math.abs(refundFee(amount) - amount / 50)).toBeLessThanOrEqual(0.5);
      }),
      RUNS,
    );
  });

  // INVARIANT: and the two halves meet. Whatever the refund, the platform's cut
  // is at least the minimum (or the whole refund) and never more than the larger
  // of the minimum and the rate.
  it("never keeps more than the larger of the minimum and the rate", () => {
    fc.assert(
      fc.property(wholeCentsArb, (amount) => {
        const fee = refundFee(amount);
        if (amount <= 0) {
          expect(fee).toBe(0);
          return;
        }
        expect(fee).toBeLessThanOrEqual(Math.max(50, amount / 50 + 0.5));
      }),
      RUNS,
    );
  });

  // INVARIANT: a bigger refund is never worse for either side. Over whole cents
  // the platform's cut never shrinks as the refund grows, and neither does the
  // amount the customer ends up holding — an extra cent of refund can never cost
  // the customer money.
  it("never leaves either side worse off when the refund grows", () => {
    fc.assert(
      fc.property(wholeCentsArb, wholeCentsArb, (a, b) => {
        const [smaller, larger] = a <= b ? [a, b] : [b, a];
        expect(refundFee(larger)).toBeGreaterThanOrEqual(refundFee(smaller));
        const inHand = (r: number) => Math.max(0, r - refundFee(r));
        expect(inHand(larger)).toBeGreaterThanOrEqual(inHand(smaller));
      }),
      RUNS,
    );
  });

  // INVARIANT: consecutive cents cannot leapfrog. One more cent of refund moves
  // the customer's take by nothing or by exactly that cent — never by more, so
  // the fee schedule has no step that pays a customer for a cent they never got.
  it("moves the customer's take by at most the cent that was added", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (amount) => {
        const inHand = (r: number) => Math.max(0, r - refundFee(r));
        const step = inHand(amount) - inHand(amount - 1);
        expect(step).toBeGreaterThanOrEqual(0);
        expect(step).toBeLessThanOrEqual(1);
      }),
      RUNS,
    );
  });
});

describe("netRefund — every cent is accounted for", () => {
  // INVARIANT: no cent is created and none goes missing. What the customer is
  // handed plus what the platform keeps equals the refund, exactly, on both
  // sides of the event start.
  it("splits the refund exactly between the customer and the platform", () => {
    fc.assert(
      fc.property(
        orderArb.chain((order) =>
          fc.record({
            order: fc.constant(order),
            cancelled: fc.integer({ min: 0, max: order.tickets }),
            now: fc.oneof(
              gapArb.map((g) => before(order.eventStartMs, g)),
              gapArb.map((g) => atOrAfter(order.eventStartMs, g)),
            ),
          }),
        ),
        ({ order, cancelled, now }) => {
          const gross = calculateRefund(order, cancelled, now);
          const net = netRefund(order, cancelled, now);
          expect(net + refundFee(gross)).toBe(gross);
          expect(net).toBeGreaterThanOrEqual(0);
          expect(net).toBeLessThanOrEqual(order.totalCents);
        },
      ),
      RUNS,
    );
  });

  // INVARIANT: a refund the minimum fee swallows leaves the customer with
  // nothing, and never with a debt. Small refunds are absorbed, not inverted.
  it("hands back nothing, and never less than nothing, when the fee swallows the refund", () => {
    fc.assert(
      fc.property(
        orderArb.chain((order) =>
          fc.record({
            order: fc.constant(order),
            cancelled: fc.integer({ min: 0, max: order.tickets }),
            early: gapArb.map((g) => before(order.eventStartMs, g)),
          }),
        ),
        ({ order, cancelled, early }) => {
          const gross = calculateRefund(order, cancelled, early);
          const net = netRefund(order, cancelled, early);
          if (gross <= 50) expect(net).toBe(0);
          expect(net).toBeGreaterThanOrEqual(0);
        },
      ),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Generator census — a property that never reaches the ugly inputs proves
// nothing, so these assert the generators above actually get there.
// ---------------------------------------------------------------------------
describe("generator census — the properties above see the ugly cases", () => {
  const sample = <T>(arb: fc.Arbitrary<T>, n = 4000): T[] => fc.sample(arb, { numRuns: n, seed: 20260726 });

  it("the clock index really is a strictly increasing map over the doubles it is used on", () => {
    // In strictly increasing order of the instant they name.
    const clocks = [
      -1e308,
      -1e15,
      -1_700_000_000_000,
      -1.5,
      -1,
      -Number.EPSILON,
      -1e-300,
      -Number.MIN_VALUE,
      -0,
      0,
      Number.MIN_VALUE,
      1e-300,
      Number.EPSILON,
      1,
      1.5,
      1_700_000_000_000,
      1e15,
      1e308,
    ];
    for (let i = 1; i < clocks.length; i++) {
      const a = clockIndex(clocks[i - 1]);
      const b = clockIndex(clocks[i]);
      expect(a <= b).toBe(true);
      expect(clockAt(clockIndex(clocks[i]))).toBe(clocks[i] === 0 ? 0 : clocks[i]);
    }
    // and consecutive instants get consecutive indices, so the search cannot
    // step over the boundary it is looking for.
    for (const t of [0, 1, -1, 1.5, 1_700_000_000_000, -1e12, 1e-300]) {
      expect(clockIndex(nextDouble(t)) - clockIndex(t)).toBe(1n);
      expect(clockIndex(t) - clockIndex(previousDouble(t))).toBe(1n);
    }
  });

  it("the searched cases mostly do pay real money, so the search is not vacuous", () => {
    const cases = sample(payingCase);
    const paying = cases.filter(
      ({ order, cancelled }) => calculateRefund(order, cancelled, previousDouble(order.eventStartMs)) > 0,
    );
    expect(paying.length).toBeGreaterThan(cases.length * 0.5);
  });

  it("event starts reach the epoch, negative time, sub-millisecond times and dates past the platform", () => {
    const starts = sample(startArb);
    expect(starts.filter((s) => s === 0).length).toBeGreaterThan(0);
    expect(starts.filter((s) => s < 0).length).toBeGreaterThan(100);
    expect(starts.filter((s) => !Number.isInteger(s)).length).toBeGreaterThan(0);
    expect(starts.filter((s) => Math.abs(s) > 0 && Math.abs(s) < 1e-100).length).toBeGreaterThan(0);
    expect(starts.filter((s) => s >= 4_000_000_000_000).length).toBeGreaterThan(0);
    expect(starts.every((s) => Number.isFinite(previousDouble(s)) && Number.isFinite(nextDouble(s)))).toBe(true);
  });

  it("the clocks under test reach one ULP either side of the start, the start itself, and a century out", () => {
    const cases = sample(
      startArb.chain((start) =>
        fc.record({
          start: fc.constant(start),
          early: gapArb.map((g) => before(start, g)),
          late: gapArb.map((g) => atOrAfter(start, g)),
        }),
      ),
    );
    expect(cases.every((c) => c.early < c.start && Number.isFinite(c.early))).toBe(true);
    expect(cases.every((c) => c.late >= c.start && Number.isFinite(c.late))).toBe(true);
    expect(cases.filter((c) => c.early === previousDouble(c.start)).length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.late === c.start).length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.late === nextDouble(c.start)).length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.start - c.early >= 3_153_600_000_000).length).toBeGreaterThan(0);
    expect(cases.filter((c) => c.late - c.start >= 3_153_600_000_000).length).toBeGreaterThan(0);
  });

  it("the fee amounts reach zero, one cent, both fee cliffs, fractions of a cent and the top of the range", () => {
    const amounts = sample(anyFiniteAmountArb);
    expect(amounts.filter((a) => a === 0).length).toBeGreaterThan(0);
    expect(amounts.filter((a) => a === 1).length).toBeGreaterThan(0);
    expect(amounts.filter((a) => a > 0 && a <= 50).length).toBeGreaterThan(0);
    expect(amounts.filter((a) => a >= 2475 && a <= 2550).length).toBeGreaterThan(0);
    expect(amounts.filter((a) => a < 0).length).toBeGreaterThan(0);
    expect(amounts.filter((a) => a !== 0 && !Number.isInteger(a)).length).toBeGreaterThan(0);
    expect(amounts.filter((a) => a > Number.MAX_SAFE_INTEGER - 1_001).length).toBeGreaterThan(0);
  });

  it("the whole-cent amounts reach the 50-cent floor, the point 2% overtakes it, and MAX_SAFE_INTEGER", () => {
    const amounts = sample(wholeCentsArb);
    expect(amounts.every(Number.isInteger)).toBe(true);
    expect(amounts.filter((a) => a === 50).length).toBeGreaterThan(0);
    expect(amounts.filter((a) => a === 2525).length).toBeGreaterThan(0);
    expect(amounts.filter((a) => a > Number.MAX_SAFE_INTEGER - 1_001).length).toBeGreaterThan(0);
  });

  it("the orders under test reach free orders, one-cent orders, 100% discounts and huge ticket counts", () => {
    const orders = sample(orderArb);
    expect(orders.filter((o) => o.totalCents === 0).length).toBeGreaterThan(0);
    expect(orders.filter((o) => o.totalCents === 1).length).toBeGreaterThan(0);
    expect(orders.filter((o) => o.discountPercent === 100).length).toBeGreaterThan(0);
    expect(orders.filter((o) => o.tickets === 1).length).toBeGreaterThan(0);
    expect(orders.filter((o) => o.tickets > 1_000_000).length).toBeGreaterThan(0);
    expect(orders.filter((o) => o.tickets > o.totalCents).length).toBeGreaterThan(0);
    expect(orders.filter((o) => o.totalCents % o.tickets !== 0).length).toBeGreaterThan(0);
  });
});
