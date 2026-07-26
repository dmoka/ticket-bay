// Property-based suite for the promises src/refund.ts makes in prose.
//
// The docstrings in src/ ARE the specification. This file walks them line by
// line and encodes every rule they promise as a property — including the rules
// that turn out not to be enforced anywhere in the implementation. A promise
// the code does not keep is a defect, not a documentation bug.
//
// Nothing here re-derives the implementation's arithmetic. Every property is
// stated in English above the code that encodes it, and every one of them is
// something a customer, an auditor or a finance team would recognise as true
// without reading a line of TypeScript.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { calculateRefund, netRefund, Order } from "../src/refund";
import { bookTickets, groupDiscount, seatsAvailable, Event } from "../src/booking";

// ---------------------------------------------------------------------------
// Clock helpers.
//
// Timestamps are doubles, so "the instant just after the event starts" cannot
// be written as `start + epsilon`: at epoch scale (~1.7e12) every delta below
// ~0.0002 ms is absorbed straight back into `start`. These walk the actual
// representable neighbours so the boundary properties test the boundary and
// not a value that quietly collapsed onto it.
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

// ---------------------------------------------------------------------------
// Generators.
//
// These are audited by the "generator census" block at the bottom of the file,
// which fails if any of the ugly buckets stops being produced. A property that
// passes 3000 runs against a generator that only ever emits comfortable values
// is theatre; the census is what stops this file from becoming that.
// ---------------------------------------------------------------------------

/** Event start instants, all of them values calculateRefund accepts. */
const startArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, -1, 1.5, 1_700_000_000_000, 2_000_000_000_000) },
  { weight: 3, arbitrary: fc.integer({ min: -1_000_000_000_000, max: 4_000_000_000_000 }) },
  { weight: 1, arbitrary: fc.constantFrom(Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, Number.MIN_VALUE) },
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

/** A clock reading strictly before the event starts — refunds are open. */
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
  open: number;
}

const gateCase = (cents: fc.Arbitrary<number> = centsArb): fc.Arbitrary<GateCase> =>
  orderArb(cents).chain((order) =>
    fc.record({
      order: fc.constant(order),
      cancelled: fc.integer({ min: 0, max: order.tickets }),
      open: before(order.eventStartMs),
    }),
  );

/** Cancellations that actually cancel something, on orders that actually cost something. */
const payingGateCase: fc.Arbitrary<GateCase> = orderArb(payingCentsArb).chain((order) =>
  fc.record({
    order: fc.constant(order),
    cancelled: fc.integer({ min: 1, max: order.tickets }),
    open: before(order.eventStartMs),
  }),
);

const RUNS = { numRuns: 3000 } as const;

// ---------------------------------------------------------------------------
// "informational" and "stateless by contract"
//
// src/refund.ts:6  "percentage discount applied at purchase, 0-100 (informational)"
// src/refund.ts:19 "Stateless by contract"
// ---------------------------------------------------------------------------
describe("the documented shape of the contract", () => {
  // INVARIANT: `discountPercent` is informational. `totalCents` is what was
  // actually paid, so the discount field must not move a single cent — two
  // orders that differ only in the label refund identically.
  it("the discount label never changes the money", () => {
    fc.assert(
      fc.property(gateCase(), discountArb, ({ order, cancelled, open }, otherDiscount) => {
        const relabelled: Order = { ...order, discountPercent: otherDiscount };
        expect(calculateRefund(relabelled, cancelled, open)).toBe(calculateRefund(order, cancelled, open));
        expect(netRefund(relabelled, cancelled, open)).toBe(netRefund(order, cancelled, open));
      }),
      RUNS,
    );
  });

  // INVARIANT: stateless by contract — the same question asked twice gets the
  // same answer, and asking it never changes the order. A refund calculator
  // that mutated its input would make the caller's running total wrong.
  it("answering twice gives the same answer and leaves the order untouched", () => {
    fc.assert(
      fc.property(gateCase(), ({ order, cancelled, open }) => {
        const snapshot = JSON.stringify(order);
        const first = calculateRefund(order, cancelled, open);
        const second = calculateRefund(order, cancelled, open);
        netRefund(order, cancelled, open);
        expect(second).toBe(first);
        expect(JSON.stringify(order)).toBe(snapshot);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// booking feeds refunds
//
// src/booking.ts:18 "Book n tickets; returns the new order. Throws when not
//                    enough seats."
// src/booking.ts:32 "Group discount tiers: 5+ tickets 5%, 10+ tickets 10%."
// ---------------------------------------------------------------------------
describe("bookTickets and the refund path agree on what an order is", () => {
  /**
   * Every price bookTickets itself admits. Its own guard is
   * `Number.isInteger(ev.priceCents) && ev.priceCents >= 0` (src/booking.ts:24),
   * so this generator emits nothing the function claims to reject.
   */
  const anyAdmittedPrice = fc.oneof(
    { weight: 4, arbitrary: fc.oneof(fc.constantFrom(0, 1, 2, 99, 5_000), fc.integer({ min: 0, max: 10_000_000 })) },
    { weight: 2, arbitrary: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }) },
    { weight: 1, arbitrary: fc.constantFrom(Number.MAX_SAFE_INTEGER, 2 ** 52, 2 ** 52 + 1) },
  );

  const eventArb: fc.Arbitrary<Event> = fc
    .record({
      totalSeats: fc.integer({ min: 1, max: 5_000 }),
      priceCents: anyAdmittedPrice,
      startMs: startArb,
    })
    .chain(({ totalSeats, priceCents, startMs }) =>
      fc
        .integer({ min: 0, max: totalSeats - 1 })
        .map((seatsSold) => ({ id: "e1", name: "RockFest", totalSeats, seatsSold, priceCents, startMs })),
    );

  const bookingArb = eventArb.chain((ev) =>
    fc.record({
      ev: fc.constant(ev),
      n: fc.integer({ min: 1, max: Math.max(1, ev.totalSeats - ev.seatsSold) }),
      discount: discountArb,
    }),
  );

  /**
   * The exact total, computed in BigInt so it is not the float arithmetic under
   * test. `priceCents * n` is representable as a Number exactly when this is at
   * most MAX_SAFE_INTEGER; above that, "the amount actually paid" is not a
   * quantity JavaScript can hold, so no correct implementation can sell it.
   */
  const exactGross = (priceCents: number, n: number) => BigInt(priceCents) * BigInt(n);
  const representable = (priceCents: number, n: number) =>
    exactGross(priceCents, n) <= BigInt(Number.MAX_SAFE_INTEGER);

  /**
   * Book, reporting a refusal instead of throwing.
   *
   * These invariants are all conditional on booking having sold something —
   * "never builds an unrefundable order" is satisfied by declining to build it.
   * Round 1 of this file got that wrong: it called bookTickets unguarded, which
   * quietly demanded that booking succeed on EVERY generated input, a stronger
   * claim than any docstring makes and an impossible one once the price times
   * the quantity exceeds what a Number can represent.
   */
  function tryBook(ev: Event, n: number, discount: number): { order?: Order; refusal?: unknown } {
    try {
      return { order: bookTickets(ev, n, discount) };
    } catch (refusal) {
      return { refusal };
    }
  }

  // INVARIANT: booking must never build an order the refund path refuses. Any
  // ticket the platform is willing to sell is a ticket it must be able to price
  // a cancellation for; an order that cannot be refunded at all is a customer
  // with money in and no way out. Declining the sale honours this; selling an
  // unrefundable order does not.
  //
  // The `sold` counter is the anti-vacuity guard. Now that a refusal counts as
  // satisfying the invariant, a bookTickets that refused everything would sail
  // through — so the property also fails if the generator stops producing real
  // sales. It is the assertion that keeps this test honest.
  it("every order booking accepts is one the refund path accepts", () => {
    let sold = 0;
    let refused = 0;
    fc.assert(
      fc.property(bookingArb, ({ ev, n, discount }) => {
        const { order, refusal } = tryBook(ev, n, discount);
        if (!order) {
          refused++;
          // A refusal is a documented refusal, not a crash or a wrong type.
          expect(refusal).toBeInstanceOf(RangeError);
          return;
        }
        sold++;
        expect(() => calculateRefund(order, order.tickets, strictlyBefore(order.eventStartMs, 1))).not.toThrow();
        expect(() => netRefund(order, order.tickets, strictlyBefore(order.eventStartMs, 1))).not.toThrow();
      }),
      RUNS,
    );
    expect(sold).toBeGreaterThan(RUNS.numRuns * 0.5);
    expect(refused).toBeGreaterThan(0);
  });

  // INVARIANT: booking either sells or refuses — it never returns a malformed
  // order, and it never fails in a way the caller cannot catch. Every refusal is
  // a RangeError.
  it("either returns a well-formed order or raises a RangeError", () => {
    fc.assert(
      fc.property(bookingArb, ({ ev, n, discount }) => {
        const { order, refusal } = tryBook(ev, n, discount);
        if (!order) {
          expect(refusal).toBeInstanceOf(RangeError);
          return;
        }
        expect(Number.isSafeInteger(order.totalCents)).toBe(true);
        expect(order.totalCents).toBeGreaterThanOrEqual(0);
        expect(order.tickets).toBe(n);
        expect(order.eventStartMs).toBe(ev.startMs);
        expect(order.discountPercent).toBe(discount);
      }),
      RUNS,
    );
  });

  // INVARIANT (src/booking.ts:28-32): the refusal is exactly as wide as the
  // problem. Booking declines when, and only when, the amount paid cannot be
  // represented — every order whose price times quantity fits in a Number is
  // still sold. Encoded against a BigInt oracle, so it does not restate the
  // `Number.isSafeInteger(gross)` check in the source.
  //
  // This is the property that rules out the over-broad alternative fix of
  // capping `priceCents` itself: one ticket at the maximum price is
  // representable and must still be sellable.
  it("refuses when, and only when, the total cannot be represented", () => {
    fc.assert(
      fc.property(bookingArb, ({ ev, n, discount }) => {
        // Confine this to inputs that clear every other documented guard, so the
        // only reason left to refuse is the size of the total.
        fc.pre(n <= seatsAvailable(ev) && Number.isFinite(ev.startMs) && ev.priceCents >= 0);
        const { order } = tryBook(ev, n, discount);
        expect(order !== undefined).toBe(representable(ev.priceCents, n));
      }),
      RUNS,
    );
  });

  // INVARIANT: booking never oversells. If it returned an order, the seats it
  // sold fit in the seats that were left — and if there were not enough seats
  // it refused, which is the promise src/booking.ts:18 makes in so many words.
  it("never sells more seats than the event has left", () => {
    let sold = 0;
    fc.assert(
      fc.property(bookingArb, fc.integer({ min: 1, max: 100 }), ({ ev, n, discount }, overbook) => {
        const left = seatsAvailable(ev);
        const { order } = tryBook(ev, n, discount);
        if (order) {
          sold++;
          expect(order.tickets).toBe(n);
          expect(order.tickets).toBeLessThanOrEqual(left);
          expect(ev.seatsSold + order.tickets).toBeLessThanOrEqual(ev.totalSeats);
        }
        // "Throws when not enough seats" — asking for more than is left is
        // always refused, whatever the price does.
        expect(() => bookTickets(ev, left + overbook, discount)).toThrow(RangeError);
      }),
      RUNS,
    );
    expect(sold).toBeGreaterThan(RUNS.numRuns * 0.5);
  });

  // INVARIANT: what the order records as paid is list price times quantity, less
  // the discount. Checked against an exact rational in BigInt, so the oracle is
  // independent of the float arithmetic in src/booking.ts:33.
  //
  // The tolerance is derived, not fitted: `gross * (1 - d/100)` rounds twice in
  // double precision, each step costing at most a relative Number.EPSILON, and
  // Math.round adds half a cent. At realistic ticket prices that bound is one
  // cent; it only widens near the top of the representable range, where a cent
  // of drift on a seventeen-trillion-euro order is the price of using doubles.
  it("records a paid total that matches list price less the discount", () => {
    fc.assert(
      fc.property(bookingArb.filter(({ discount }) => Number.isInteger(discount)), ({ ev, n, discount }) => {
        const { order } = tryBook(ev, n, discount);
        if (!order) return;
        const gross = exactGross(ev.priceCents, n);
        const numerator = gross * BigInt(100 - discount);
        const exact = numerator / 100n + ((numerator % 100n) * 2n >= 100n ? 1n : 0n);
        const tolerance = 1 + 2 * Number(gross) * Number.EPSILON;
        expect(Math.abs(order.totalCents - Number(exact))).toBeLessThanOrEqual(tolerance);
        // Whatever the rounding does, a discount only ever lowers the price.
        expect(BigInt(order.totalCents)).toBeLessThanOrEqual(gross);
      }),
      RUNS,
    );
  });

  // Deterministic pins for the boundary of the representable range. The first is
  // the case a price-based guard would wrongly refuse; the second is the
  // counterexample from round 1.
  it("sells and refunds a single ticket at the largest representable price", () => {
    const ev: Event = {
      id: "e1", name: "RockFest", totalSeats: 10, seatsSold: 0,
      priceCents: Number.MAX_SAFE_INTEGER, startMs: 1_700_000_000_000,
    };
    const order = bookTickets(ev, 1, 0);
    expect(order.totalCents).toBe(Number.MAX_SAFE_INTEGER);
    expect(calculateRefund(order, 1, ev.startMs - 1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("refuses the pair whose total is one cent past the representable range", () => {
    const ev: Event = {
      id: "e1", name: "RockFest", totalSeats: 10, seatsSold: 0,
      priceCents: 2 ** 52, startMs: 1_700_000_000_000,
    };
    // 2**52 * 2 === 2**53, one above Number.MAX_SAFE_INTEGER.
    expect(() => bookTickets(ev, 2, 0)).toThrow(RangeError);
    expect(() => bookTickets(ev, 1, 0)).not.toThrow();
  });

  // INVARIANT: seats left is never negative and never more than the hall holds.
  it("seats available is between zero and the size of the hall", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 20_000 }), (totalSeats, seatsSold) => {
        const left = seatsAvailable({ id: "e", name: "n", totalSeats, seatsSold, priceCents: 1, startMs: 0 });
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left).toBeLessThanOrEqual(totalSeats);
      }),
      RUNS,
    );
  });

  // INVARIANT (src/booking.ts:32): the tiers are 0 / 5 / 10 and they only ever
  // grow with the size of the group — a bigger group never gets a worse deal.
  it("group discounts are one of the three published tiers and never shrink", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 100 }), (n, more) => {
        expect([0, 5, 10]).toContain(groupDiscount(n));
        expect(groupDiscount(n + more)).toBeGreaterThanOrEqual(groupDiscount(n));
        if (n < 5) expect(groupDiscount(n)).toBe(0);
        if (n >= 5 && n < 10) expect(groupDiscount(n)).toBe(5);
        if (n >= 10) expect(groupDiscount(n)).toBe(10);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Generator census.
//
// A green property is only worth what its generator produced. These sample the
// arbitraries used above and fail if any of the buckets that matter has gone
// empty — so a future edit that quietly narrows a generator breaks a test
// instead of silently turning the properties into decoration.
// ---------------------------------------------------------------------------
describe("generator census — the properties above see the ugly cases", () => {
  const SAMPLES = 5_000;

  it("the clock generator is always strictly before the start, including one ULP before", () => {
    const start = 1_700_000_000_000;
    const clocks = fc.sample(before(start), SAMPLES);
    expect(clocks.every((t) => t < start)).toBe(true);
    expect(clocks.filter((t) => t === previousDouble(start)).length).toBeGreaterThan(0);
  });

  it("the money generator reaches zero, one cent, the fee cliff and MAX_SAFE_INTEGER", () => {
    const cents = fc.sample(centsArb, SAMPLES);
    expect(cents.filter((c) => c === 0).length).toBeGreaterThan(0);
    expect(cents.filter((c) => c === 1).length).toBeGreaterThan(0);
    expect(cents.filter((c) => c > 0 && c <= 50).length).toBeGreaterThan(SAMPLES * 0.02);
    expect(cents.filter((c) => c > Number.MAX_SAFE_INTEGER / 2).length).toBeGreaterThan(0);
    expect(cents.every((c) => Number.isInteger(c) && c >= 0 && c <= Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("orders reach 100% discounts and totals that do not divide by their ticket count", () => {
    const orders = fc.sample(orderArb(), SAMPLES);
    expect(orders.filter((o) => o.discountPercent === 100).length).toBeGreaterThan(0);
    expect(orders.filter((o) => !Number.isInteger(o.discountPercent)).length).toBeGreaterThan(0);
    expect(orders.filter((o) => o.tickets > 1 && o.totalCents % o.tickets !== 0).length).toBeGreaterThan(SAMPLES * 0.2);
    expect(orders.filter((o) => o.totalCents > 0 && o.totalCents < o.tickets).length).toBeGreaterThan(0);
    expect(orders.filter((o) => o.eventStartMs <= 0).length).toBeGreaterThan(0);
  });
});
