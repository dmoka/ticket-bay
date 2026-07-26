// Property-based suite for the refund money path.
//
// These test INVARIANTS derived from the docstrings in src/refund.ts, not the
// formulas in it. Re-deriving `Math.round(total * cancelled / tickets)` here
// would prove nothing except that the code equals itself.
//
// Every invariant is stated in English above the property that encodes it.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { calculateRefund, netRefund, refundFee, Order } from "../src/refund";
import { bookTickets, Event } from "../src/booking";

// ---------------------------------------------------------------------------
// Generators. These deliberately cover the ugly ranges: 0, 1 cent, the 50-cent
// minimum-fee cliff, the 2%-crosses-50 cliff (2475), odd ticket counts that
// never divide evenly, 100% discounts, and the top of the range the validator
// in calculateRefund explicitly admits (Number.MAX_SAFE_INTEGER).
// ---------------------------------------------------------------------------

/** Money a real order could plausibly hold: 0 cents up to ten billion euros. */
const realisticCents = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, 2, 3, 5, 6, 49, 50, 51, 99, 100, 101, 2474, 2475, 2476, 2500, 9999, 10000) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 1_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 1_000_000 }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: 1_000_000_000_000 }) },
);

/** Ticket counts, biased towards the ones that divide badly. */
const realisticTickets = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(1, 2, 3, 4, 7, 11, 12, 13, 97) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 1_000 }) },
);

/**
 * The full range calculateRefund says it accepts: `totalCents` is validated as
 * `>= 0 && <= Number.MAX_SAFE_INTEGER`, so every value in here is in-spec.
 */
const admittedCents = fc.oneof(
  { weight: 4, arbitrary: realisticCents },
  { weight: 3, arbitrary: fc.integer({ min: Number.MAX_SAFE_INTEGER - 10_000, max: Number.MAX_SAFE_INTEGER }) },
  { weight: 1, arbitrary: fc.constantFrom(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, 2 ** 53 - 6, 2 ** 52 + 1) },
);

/** Discounts, including the 100% freebie and non-integer percentages. */
const discountArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(0, 1, 5, 10, 50, 99, 100) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 100 }) },
  { weight: 1, arbitrary: fc.double({ min: 0, max: 100, noNaN: true }) },
);

/** Timestamps: epoch, pre-epoch, fractional ms, and far future. */
const msArb = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(0, 1, -1, 1.5, 1_700_000_000_000, 2_000_000_000_000) },
  { weight: 3, arbitrary: fc.integer({ min: -1_000_000_000_000, max: 4_000_000_000_000 }) },
);

interface Scenario {
  order: Order;
  cancelled: number;
  /** a moment strictly before the event starts — refunds are open */
  beforeStart: number;
  /** a moment at or after the event start — the spec says refunds are closed */
  afterStart: number;
}

// A timestamp one ULP before `v`. Needed because `v - 5e-324` is absorbed
// straight back to `v` at every magnitude above ~1 — subtracting a tiny delta
// from an epoch-scale double does NOT produce an earlier instant, it produces
// the same instant. Without this, "just before the event starts" silently
// generated "exactly at the event start", where the refund is correctly zero.
const f64 = new Float64Array(1);
const i64 = new BigInt64Array(f64.buffer);

/** The largest double strictly less than `v`. */
function previousDouble(v: number): number {
  if (v === 0) return -Number.MIN_VALUE;
  f64[0] = v;
  i64[0] += v > 0 ? -1n : 1n;
  return f64[0];
}

/**
 * `start - delta`, but guaranteed to be strictly earlier than `start`. When the
 * delta is too small to move the double, fall back to the nearest representable
 * instant before it — the tightest possible open-side boundary.
 */
function strictlyBefore(start: number, delta: number): number {
  const candidate = start - delta;
  return candidate < start ? candidate : previousDouble(start);
}

const scenarioWith = (cents: fc.Arbitrary<number>, tickets = realisticTickets): fc.Arbitrary<Scenario> =>
  fc
    .record({
      totalCents: cents,
      tickets,
      discountPercent: discountArb,
      eventStartMs: msArb,
    })
    .chain((order) =>
      fc.record({
        order: fc.constant(order),
        cancelled: fc.integer({ min: 0, max: order.tickets }),
        beforeStart: fc
          .oneof(
            fc.constant(1),
            fc.integer({ min: 1, max: 10_000_000_000 }),
            fc.double({ min: Number.MIN_VALUE, max: 1, noNaN: true }),
          )
          .map((delta) => strictlyBefore(order.eventStartMs, delta)),
        afterStart: fc
          .oneof(
            fc.constant(0), // exactly eventStartMs — the boundary the spec calls out
            fc.integer({ min: 0, max: 10_000_000_000 }),
            fc.double({ min: 0, max: 1, noNaN: true }),
          )
          .map((delta) => order.eventStartMs + delta),
      }),
    );

const realisticScenario = scenarioWith(realisticCents);
const admittedScenario = scenarioWith(admittedCents);

const RUNS = { numRuns: 3000 } as const;

// ---------------------------------------------------------------------------
// calculateRefund — bounds and proportionality
// ---------------------------------------------------------------------------
describe("calculateRefund — invariants", () => {
  // INVARIANT: a refund is money leaving the platform, so it is never negative
  // and never more than the customer actually paid.
  it("a refund is never negative and never exceeds what was paid", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, cancelled, beforeStart }) => {
        const r = calculateRefund(order, cancelled, beforeStart);
        expect(Number.isFinite(r)).toBe(true);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThanOrEqual(order.totalCents);
      }),
      RUNS,
    );
  });

  // INVARIANT: a refund is always a whole number of cents. There is no such
  // thing as paying out a third of a cent.
  it("a refund is always a whole number of cents", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, cancelled, beforeStart }) => {
        expect(Number.isInteger(calculateRefund(order, cancelled, beforeStart))).toBe(true);
      }),
      RUNS,
    );
  });

  // INVARIANT: cancelling nothing refunds nothing.
  it("cancelling zero tickets refunds zero", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, beforeStart }) => {
        expect(calculateRefund(order, 0, beforeStart)).toBe(0);
      }),
      RUNS,
    );
  });

  // INVARIANT: cancelling every ticket returns the whole amount paid — the
  // discounted total, exactly, to the cent. No rounding may shave it.
  it("cancelling all tickets refunds the full amount paid", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, beforeStart }) => {
        expect(calculateRefund(order, order.tickets, beforeStart)).toBe(order.totalCents);
      }),
      RUNS,
    );
  });

  // INVARIANT: cancelling more tickets never refunds less money.
  it("the refund is non-decreasing in the number of tickets cancelled", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, cancelled, beforeStart }) => {
        for (const c of [cancelled, Math.max(0, cancelled - 1)]) {
          if (c + 1 > order.tickets) continue;
          expect(calculateRefund(order, c + 1, beforeStart)).toBeGreaterThanOrEqual(
            calculateRefund(order, c, beforeStart),
          );
        }
      }),
      RUNS,
    );
  });

  // INVARIANT: a free order (100% discount, or a zero-priced event) refunds
  // zero for any number of cancelled tickets — never a phantom payout.
  it("an order that cost nothing refunds nothing", () => {
    fc.assert(
      fc.property(realisticTickets, msArb, discountArb, (tickets, eventStartMs, discountPercent) => {
        const order: Order = { totalCents: 0, tickets, discountPercent, eventStartMs };
        for (const c of [0, 1, tickets]) {
          expect(calculateRefund(order, c, strictlyBefore(eventStartMs, 1))).toBe(0);
        }
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// calculateRefund — the time gate
//
// src/refund.ts:16-17 states the rule as spec:
//   "cancellations are only allowed BEFORE the event starts.
//    From `eventStartMs` on, the refund is zero."
// ---------------------------------------------------------------------------
describe("calculateRefund — time gate (spec: refunds close at eventStartMs)", () => {
  // INVARIANT (about this suite, not the source): the two sides of the boundary
  // are really on opposite sides of it. A generator that quietly produces
  // `beforeStart === eventStartMs` tests the closed side twice and the open
  // side never, which is how a passing suite stops meaning anything.
  it("the generator puts beforeStart strictly before, and afterStart at or after, the event start", () => {
    fc.assert(
      fc.property(admittedScenario, ({ order, beforeStart, afterStart }) => {
        expect(beforeStart).toBeLessThan(order.eventStartMs);
        expect(afterStart).toBeGreaterThanOrEqual(order.eventStartMs);
        expect(Number.isFinite(beforeStart)).toBe(true);
        expect(Number.isFinite(afterStart)).toBe(true);
      }),
      RUNS,
    );
  });

  // INVARIANT: a clock that cannot be read must never authorise a payout. It
  // may be refused or treated as closed, but it must not pay.
  it("never pays out on an unreadable clock", () => {
    fc.assert(
      fc.property(
        realisticScenario,
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        ({ order, cancelled }, brokenClock) => {
          for (const fn of [calculateRefund, netRefund]) {
            let paid: number;
            try {
              paid = fn(order, cancelled, brokenClock);
            } catch (e) {
              expect(e).toBeInstanceOf(RangeError);
              continue;
            }
            expect(paid).toBe(0);
          }
        },
      ),
      RUNS,
    );
  });

  // INVARIANT: at or after the event start, the refund is zero. `eventStartMs`
  // itself is closed ("from eventStartMs on").
  it("refunds nothing once the event has started", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, cancelled, afterStart }) => {
        expect(calculateRefund(order, cancelled, afterStart)).toBe(0);
      }),
      RUNS,
    );
  });

  // INVARIANT: the gate is a function of time only — it closes for every order
  // shape, including the smallest possible one.
  it("refunds nothing at exactly eventStartMs, for a one-cent one-ticket order", () => {
    const order: Order = { totalCents: 1, tickets: 1, discountPercent: 0, eventStartMs: 0 };
    expect(calculateRefund(order, 1, 0)).toBe(0);
  });

  // INVARIANT: before the event starts the gate is open, so a paid order with
  // tickets cancelled pays something back.
  it("refunds a positive amount before the event starts when there is money to return", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, beforeStart }) => {
        if (order.totalCents < order.tickets) return; // sub-cent per ticket rounds to nothing
        expect(calculateRefund(order, order.tickets, beforeStart)).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });

  // INVARIANT: nothing about the refund depends on the clock while the gate is
  // open — two moments before the start give the same answer.
  it("the amount does not drift with the clock while refunds are open", () => {
    fc.assert(
      fc.property(realisticScenario, msArb, ({ order, cancelled, beforeStart }, other) => {
        const otherBefore = strictlyBefore(Math.min(beforeStart, other), 1);
        expect(calculateRefund(order, cancelled, beforeStart)).toBe(
          calculateRefund(order, cancelled, otherBefore),
        );
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// refundFee
//
// src/refund.ts:38 states the spec: "Fee kept by the platform on every refund,
// in cents. Min 50, 2% of refund."
// ---------------------------------------------------------------------------
describe("refundFee — invariants", () => {
  const feeInput = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(-1, 0, 1, 2, 49, 50, 51, 2474, 2475, 2476, 2500, 5000) },
    { weight: 2, arbitrary: fc.integer({ min: -100, max: 10_000 }) },
    { weight: 2, arbitrary: fc.integer({ min: 0, max: 100_000_000 }) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }) },
  );

  // INVARIANT: the platform never keeps more than the refund itself, and never
  // hands money to the customer on top of the refund.
  //
  // This is the invariant that makes the `net > 0 ? net : 0` clamp in
  // netRefund unreachable: while the fee is capped at the refund, net can never
  // go negative. The clamp is therefore dead code, and no test can kill its
  // mutants — which is exactly why this property matters. Loosen the cap at
  // src/refund.ts:67 and this fails at refundCents = 1 (fee 50 > refund 1),
  // as does the net + fee conservation property below.
  it("the fee is between zero and the refund", () => {
    fc.assert(
      fc.property(feeInput, (r) => {
        const fee = refundFee(r);
        expect(fee).toBeGreaterThanOrEqual(0);
        expect(fee).toBeLessThanOrEqual(Math.max(0, r));
      }),
      RUNS,
    );
  });

  // INVARIANT: no refund, no fee.
  it("charges nothing on a zero or negative refund", () => {
    fc.assert(
      fc.property(fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: 0 }), (r) => {
        expect(refundFee(r)).toBe(0);
      }),
      RUNS,
    );
  });

  // INVARIANT: the 50-cent minimum applies whenever there is 50 cents to take.
  it("keeps at least the 50-cent minimum once the refund reaches 50 cents", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom(50, 51, 99, 2475), fc.integer({ min: 50, max: Number.MAX_SAFE_INTEGER })),
        (r) => {
          expect(refundFee(r)).toBeGreaterThanOrEqual(50);
        },
      ),
      RUNS,
    );
  });

  // INVARIANT: below the minimum, the fee is capped at the refund — the
  // minimum eats the whole thing but cannot exceed it.
  it("takes the entire refund, and no more, when it is under the 50-cent minimum", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 49 }), (r) => {
        expect(refundFee(r)).toBe(r);
      }),
      RUNS,
    );
  });

  // INVARIANT: a bigger refund never carries a smaller fee.
  it("the fee is non-decreasing in the refund", () => {
    fc.assert(
      fc.property(feeInput, fc.integer({ min: 0, max: 10_000 }), (r, step) => {
        expect(refundFee(r + step)).toBeGreaterThanOrEqual(refundFee(r));
      }),
      RUNS,
    );
  });

  // INVARIANT (from "2% of refund"): above the minimum the platform's cut stays
  // at 2%, give or take the single cent that rounding to a cent can add.
  it("never keeps more than 2% (plus a cent of rounding) above the minimum", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (r) => {
        expect(refundFee(r)).toBeLessThanOrEqual(Math.max(50, r * 0.02 + 1));
      }),
      RUNS,
    );
  });

  // INVARIANT: the fee is a whole number of cents.
  it("the fee is a whole number of cents", () => {
    fc.assert(
      fc.property(feeInput, (r) => {
        expect(Number.isInteger(refundFee(r))).toBe(true);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// netRefund
// ---------------------------------------------------------------------------
describe("netRefund — invariants", () => {
  // INVARIANT: the customer never receives more than the gross refund, and
  // never less than nothing.
  it("is between zero and the gross refund", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, cancelled, beforeStart }) => {
        const gross = calculateRefund(order, cancelled, beforeStart);
        const net = netRefund(order, cancelled, beforeStart);
        expect(net).toBeGreaterThanOrEqual(0);
        expect(net).toBeLessThanOrEqual(gross);
        expect(net).toBeLessThanOrEqual(order.totalCents);
      }),
      RUNS,
    );
  });

  // INVARIANT: money is conserved — what the customer gets plus what the
  // platform keeps is exactly the gross refund. If this ever fails, the
  // `net > 0 ? net : 0` clamp in netRefund is silently swallowing cents.
  it("net + fee equals the gross refund exactly (no cents vanish in the clamp)", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, cancelled, beforeStart }) => {
        const gross = calculateRefund(order, cancelled, beforeStart);
        const net = netRefund(order, cancelled, beforeStart);
        expect(net + refundFee(gross)).toBe(gross);
      }),
      RUNS,
    );
  });

  // INVARIANT: cancelling more tickets never nets the customer less money.
  it("is non-decreasing in the number of tickets cancelled", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, cancelled, beforeStart }) => {
        if (cancelled + 1 > order.tickets) return;
        expect(netRefund(order, cancelled + 1, beforeStart)).toBeGreaterThanOrEqual(
          netRefund(order, cancelled, beforeStart),
        );
      }),
      RUNS,
    );
  });

  // INVARIANT (consequence of the 50-cent minimum): a gross refund of 50 cents
  // or less returns nothing to the customer — the fee absorbs all of it.
  it("returns nothing to the customer when the gross refund is at most the minimum fee", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, cancelled, beforeStart }) => {
        const gross = calculateRefund(order, cancelled, beforeStart);
        if (gross > 50) return;
        expect(netRefund(order, cancelled, beforeStart)).toBe(0);
      }),
      RUNS,
    );
  });

  // INVARIANT: the time gate applies to the net amount too — nothing is paid
  // out once the event has started.
  it("pays out nothing once the event has started", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, cancelled, afterStart }) => {
        expect(netRefund(order, cancelled, afterStart)).toBe(0);
      }),
      RUNS,
    );
  });

  // A deterministic pin of the time gate on the net path.
  it("pays out nothing for a 51-cent order cancelled at exactly the event start", () => {
    const order: Order = { totalCents: 51, tickets: 1, discountPercent: 0, eventStartMs: 0 };
    expect(netRefund(order, 1, 0)).toBe(0);
  });

  // INVARIANT: a whole number of cents, always.
  it("is always a whole number of cents", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, cancelled, beforeStart }) => {
        expect(Number.isInteger(netRefund(order, cancelled, beforeStart))).toBe(true);
      }),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// Rounding drift when a cancellation is split
// ---------------------------------------------------------------------------
describe("split cancellations — rounding drift", () => {
  // INVARIANT: splitting a cancellation in two cannot conjure money. Rounding
  // each half to a cent can gain at most one cent overall.
  it("cancelling a+b in two goes never beats cancelling a+b at once by more than a cent", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, cancelled, beforeStart }) => {
        const a = Math.floor(cancelled / 2);
        const b = cancelled - a;
        const split = calculateRefund(order, a, beforeStart) + calculateRefund(order, b, beforeStart);
        const oneShot = calculateRefund(order, cancelled, beforeStart);
        expect(Math.abs(split - oneShot)).toBeLessThanOrEqual(1);
      }),
      RUNS,
    );
  });

  // INVARIANT: splitting into k parts can drift by at most half a cent per
  // part plus half a cent for the whole — anything beyond that is a real leak,
  // not rounding.
  it("splitting into k parts drifts by at most (k+1)/2 cents", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, cancelled, beforeStart }) => {
        const parts: number[] = [];
        let left = cancelled;
        while (left > 0) {
          const take = Math.min(left, Math.max(1, Math.ceil(order.tickets / 3)));
          parts.push(take);
          left -= take;
        }
        const split = parts.reduce((sum, p) => sum + calculateRefund(order, p, beforeStart), 0);
        const oneShot = calculateRefund(order, cancelled, beforeStart);
        expect(Math.abs(split - oneShot)).toBeLessThanOrEqual((parts.length + 1) / 2);
      }),
      RUNS,
    );
  });

  // INVARIANT: cancelling the tickets one at a time cannot pay out more than
  // the whole order plus HALF A CENT PER TICKET. That bound is exact, not
  // generous: with r = totalCents mod tickets, the piecemeal payout exceeds the
  // total by exactly (tickets - r) cents whenever 2r >= tickets, and r >= half
  // of tickets in every such case, so the overshoot can never exceed
  // tickets / 2. Verified tight — {totalCents: 150, tickets: 300} hits it
  // exactly. Anything above this bound is a real leak, not rounding.
  it("cancelling one ticket at a time overshoots the total by at most half a cent per ticket", () => {
    fc.assert(
      fc.property(realisticScenario, ({ order, beforeStart }) => {
        if (order.tickets > 200) return; // keep the loop cheap
        const perTicket = calculateRefund(order, 1, beforeStart) * order.tickets;
        expect(perTicket - order.totalCents).toBeLessThanOrEqual(order.tickets / 2);
      }),
      RUNS,
    );
  });

  // The worst per-ticket drifts found, pinned as bounds rather than exact
  // values, so that tightening the rounding later does not break these — they
  // only pin that the leak never grows.
  //
  // NOTE: the RELATIVE damage peaks at a 2x payout, and the minimal case is a
  // one-cent two-ticket order, not the hundred-ticket one. The absolute
  // overshoot is always at most half a cent per ticket; it only looks
  // catastrophic when the total is small relative to the ticket count.
  it("a 1-cent 2-ticket order does not pay out more than 2 cents one ticket at a time", () => {
    const order: Order = { totalCents: 1, tickets: 2, discountPercent: 0, eventStartMs: 1 };
    expect(calculateRefund(order, 1, 0) * 2).toBeLessThanOrEqual(2);
  });

  it("a 50-cent 100-ticket order does not pay out more than 100 cents one ticket at a time", () => {
    const order: Order = { totalCents: 50, tickets: 100, discountPercent: 0, eventStartMs: 1 };
    expect(calculateRefund(order, 1, 0) * 100).toBeLessThanOrEqual(100);
  });

  it("a 6-cent 12-ticket order does not pay out more than 12 cents one ticket at a time", () => {
    const order: Order = { totalCents: 6, tickets: 12, discountPercent: 50, eventStartMs: 1 };
    expect(calculateRefund(order, 1, 0) * 12).toBeLessThanOrEqual(12);
  });

  // A total LARGER than the ticket count still overshoots — the pathology is
  // 2 * (total mod tickets) >= tickets, not "the order cost less than it has
  // tickets". Pinned so nobody re-derives the wrong precondition from the
  // small-total examples above.
  it("a 3-cent 2-ticket order does not pay out more than 4 cents one ticket at a time", () => {
    const order: Order = { totalCents: 3, tickets: 2, discountPercent: 0, eventStartMs: 1 };
    expect(calculateRefund(order, 1, 0) * 2).toBeLessThanOrEqual(4);
  });

  it("a 10001-cent 3-ticket order does not pay out more than 10002 cents one ticket at a time", () => {
    const order: Order = { totalCents: 10001, tickets: 3, discountPercent: 33.33, eventStartMs: 1 };
    expect(calculateRefund(order, 1, 0) * 3).toBeLessThanOrEqual(10002);
  });
});

// ---------------------------------------------------------------------------
// The top of the range calculateRefund says it accepts
// ---------------------------------------------------------------------------
describe("calculateRefund — the full range the validator admits", () => {
  // INVARIANT: the guard at src/refund.ts:29 admits any integer total up to
  // Number.MAX_SAFE_INTEGER, so every such order must still obey the money
  // invariants: full cancellation returns exactly what was paid, and a refund
  // never exceeds it.
  it("cancelling all tickets refunds exactly the total, across the whole admitted range", () => {
    fc.assert(
      fc.property(admittedScenario, ({ order, beforeStart }) => {
        expect(calculateRefund(order, order.tickets, beforeStart)).toBe(order.totalCents);
      }),
      RUNS,
    );
  });

  it("never refunds more than was paid, across the whole admitted range", () => {
    fc.assert(
      fc.property(admittedScenario, ({ order, cancelled, beforeStart }) => {
        expect(calculateRefund(order, cancelled, beforeStart)).toBeLessThanOrEqual(order.totalCents);
      }),
      RUNS,
    );
  });

  // INVARIANT: money is conserved even at the top of the range — the clamp in
  // netRefund must not swallow cents there either.
  it("net + fee equals the gross refund across the whole admitted range", () => {
    fc.assert(
      fc.property(admittedScenario, ({ order, cancelled, beforeStart }) => {
        const gross = calculateRefund(order, cancelled, beforeStart);
        expect(netRefund(order, cancelled, beforeStart) + refundFee(gross)).toBe(gross);
      }),
      RUNS,
    );
  });

  // INVARIANT: monotonicity does not break down at the top of the range.
  it("the refund is still non-decreasing in cancelled tickets across the admitted range", () => {
    fc.assert(
      fc.property(admittedScenario, ({ order, cancelled, beforeStart }) => {
        if (cancelled + 1 > order.tickets) return;
        expect(calculateRefund(order, cancelled + 1, beforeStart)).toBeGreaterThanOrEqual(
          calculateRefund(order, cancelled, beforeStart),
        );
      }),
      RUNS,
    );
  });

  // A deterministic pin of the counterexample fast-check found, so the failure
  // is reproducible without a seed.
  it("refunds exactly 9007199254740985 cents when all 5 tickets of that order are cancelled", () => {
    const order: Order = {
      totalCents: 9007199254740985,
      tickets: 5,
      discountPercent: 0,
      eventStartMs: 2_000_000_000_000,
    };
    expect(calculateRefund(order, 5, 0)).toBe(9007199254740985);
  });
});

// ---------------------------------------------------------------------------
// Validation: bad input throws, it never returns a wrong number
// ---------------------------------------------------------------------------
describe("calculateRefund — validation", () => {
  // INVARIANT: an out-of-range cancellation count is refused, never silently
  // turned into a number.
  it("throws rather than returning a number for an out-of-range cancellation", () => {
    fc.assert(
      fc.property(
        realisticScenario,
        fc.oneof(
          fc.integer({ min: -1_000, max: -1 }),
          fc.double({ min: 0.1, max: 5, noInteger: true, noNaN: true }),
          fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        ),
        ({ order, beforeStart }, badCancelled) => {
          expect(() => calculateRefund(order, badCancelled, beforeStart)).toThrow(RangeError);
        },
      ),
      RUNS,
    );
  });

  it("throws when cancelling more tickets than the order holds", () => {
    fc.assert(
      fc.property(realisticScenario, fc.integer({ min: 1, max: 1_000 }), ({ order, beforeStart }, extra) => {
        expect(() => calculateRefund(order, order.tickets + extra, beforeStart)).toThrow(RangeError);
      }),
      RUNS,
    );
  });

  // INVARIANT: a malformed order is refused. It must never produce NaN, which
  // would flow straight into a payment as an unchecked amount.
  it("throws on a malformed order rather than returning NaN", () => {
    const brokenField = fc.oneof(
      fc.record({ totalCents: fc.constantFrom(Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY) }),
      fc.record({ tickets: fc.constantFrom(Number.NaN, 0, -3, 2.5) }),
      fc.record({ discountPercent: fc.constantFrom(Number.NaN, -1, 101, Number.POSITIVE_INFINITY) }),
      fc.record({ eventStartMs: fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY) }),
    );
    fc.assert(
      fc.property(realisticScenario, brokenField, ({ order, cancelled, beforeStart }, broken) => {
        const bad = { ...order, ...broken } as Order;
        const cap = Math.min(cancelled, Number.isInteger(bad.tickets) && bad.tickets > 0 ? bad.tickets : cancelled);
        let result: number | undefined;
        try {
          result = calculateRefund(bad, cap, beforeStart);
        } catch (e) {
          expect(e).toBeInstanceOf(RangeError);
          return;
        }
        // If it did not throw it must at least be sane money.
        expect(Number.isInteger(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(0);
      }),
      RUNS,
    );
  });

  // INVARIANT: netRefund refuses exactly what calculateRefund refuses — the
  // fee layer never turns a rejected refund into an accepted one.
  it("netRefund throws exactly when calculateRefund throws", () => {
    fc.assert(
      fc.property(
        realisticScenario,
        fc.integer({ min: -10, max: 1_010 }),
        ({ order, beforeStart }, anyCancelled) => {
          let grossThrew = false;
          try {
            calculateRefund(order, anyCancelled, beforeStart);
          } catch {
            grossThrew = true;
          }
          let netThrew = false;
          try {
            netRefund(order, anyCancelled, beforeStart);
          } catch {
            netThrew = true;
          }
          expect(netThrew).toBe(grossThrew);
        },
      ),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------
// booking -> refund round trip
// ---------------------------------------------------------------------------
describe("bookTickets -> calculateRefund round trip", () => {
  const eventArb: fc.Arbitrary<Event> = fc
    .record({
      totalSeats: fc.integer({ min: 1, max: 5_000 }),
      priceCents: fc.oneof(
        fc.constantFrom(0, 1, 2, 3, 33, 50, 99, 5_000),
        fc.integer({ min: 0, max: 10_000_000 }),
      ),
      startMs: msArb,
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

  // INVARIANT: whatever the customer paid at booking is exactly what a full
  // cancellation returns — including after a discount, including a free order.
  it("a full cancellation returns exactly the discounted amount that was paid", () => {
    fc.assert(
      fc.property(bookingArb, ({ ev, n, discount }) => {
        const order = bookTickets(ev, n, discount);
        expect(calculateRefund(order, order.tickets, strictlyBefore(order.eventStartMs, 1))).toBe(order.totalCents);
      }),
      RUNS,
    );
  });

  // INVARIANT: an order produced by bookTickets is always acceptable to the
  // refund path. Booking must not be able to build an order refunds reject.
  it("every order bookTickets produces is refundable without throwing", () => {
    fc.assert(
      fc.property(bookingArb, ({ ev, n, discount }) => {
        const order = bookTickets(ev, n, discount);
        for (const c of [0, 1, order.tickets]) {
          expect(() => netRefund(order, c, strictlyBefore(order.eventStartMs, 1))).not.toThrow();
        }
      }),
      RUNS,
    );
  });

  // INVARIANT: a 100% discount means a free order, and a free order refunds
  // zero — never a payout, never a throw.
  it("a 100%-discounted order costs nothing and refunds nothing", () => {
    fc.assert(
      fc.property(bookingArb, ({ ev, n }) => {
        const order = bookTickets(ev, n, 100);
        expect(order.totalCents).toBe(0);
        expect(calculateRefund(order, order.tickets, strictlyBefore(order.eventStartMs, 1))).toBe(0);
        expect(netRefund(order, order.tickets, strictlyBefore(order.eventStartMs, 1))).toBe(0);
      }),
      RUNS,
    );
  });

  // INVARIANT: the refund never exceeds the undiscounted list price of the
  // cancelled tickets — a discount can only reduce what comes back.
  it("the refund never exceeds the undiscounted price of the tickets", () => {
    fc.assert(
      fc.property(bookingArb, ({ ev, n, discount }) => {
        const order = bookTickets(ev, n, discount);
        const gross = ev.priceCents * n;
        expect(calculateRefund(order, order.tickets, strictlyBefore(order.eventStartMs, 1))).toBeLessThanOrEqual(gross);
      }),
      RUNS,
    );
  });

  // INVARIANT: the whole money path is gated on time — an order booked for an
  // event that has already started refunds nothing.
  it("an order for an already-started event refunds nothing", () => {
    fc.assert(
      fc.property(bookingArb, ({ ev, n, discount }) => {
        const order = bookTickets(ev, n, discount);
        expect(calculateRefund(order, order.tickets, order.eventStartMs)).toBe(0);
        expect(netRefund(order, order.tickets, order.eventStartMs + 1)).toBe(0);
      }),
      RUNS,
    );
  });
});
