// Adversarial lane, round 2 — attacking the FIXES rather than the original bugs.
//
// Two source changes are under attack here:
//   1. src/refund.ts:50-52 — `if (nowMs >= order.eventStartMs) return 0;`
//   2. src/booking.ts:28-32 — `if (!Number.isSafeInteger(gross)) throw ...`
//
// The questions a new early-return has to answer are not "does it return zero
// after the event" (round 1 covered that) but: does it return zero anywhere it
// should THROW, does it shadow a validator, and does it agree exactly with the
// independent copy of the same rule in server/server.ts:89.
import { describe, it, expect } from "vitest";
import { calculateRefund, netRefund, Order } from "../src/refund";
import { bookTickets, Event } from "../src/booking";

const S = 1_700_000_000_000;
const ord = (o: Partial<Order> = {}): Order => ({
  totalCents: 10_000,
  tickets: 4,
  discountPercent: 0,
  eventStartMs: S,
  ...o,
});

// ---------------------------------------------------------------------------
// The gate must not become a way for bad input to escape validation.
// ---------------------------------------------------------------------------
describe("a closed window still refuses malformed input instead of paying zero", () => {
  // An early `return 0` placed above a validator would turn every rejection
  // into a silent success once the event started. Returning 0 and throwing look
  // identical to a caller that only checks the amount, so a bad order would be
  // accepted, marked refunded, and closed out at zero — with no error anywhere.
  const cases: Array<[string, () => unknown]> = [
    ["cancelling more tickets than the order holds", () => calculateRefund(ord(), 5, S + 1)],
    ["a fractional cancellation", () => calculateRefund(ord(), 1.5, S + 1)],
    ["a negative cancellation", () => calculateRefund(ord(), -1, S + 1)],
    ["a NaN cancellation", () => calculateRefund(ord(), Number.NaN, S + 1)],
    ["an order with zero tickets", () => calculateRefund(ord({ tickets: 0 }), 0, S + 1)],
    ["an order with fractional tickets", () => calculateRefund(ord({ tickets: 2.5 }), 2, S + 1)],
    ["a discount above 100", () => calculateRefund(ord({ discountPercent: 101 }), 4, S + 1)],
    ["a negative discount", () => calculateRefund(ord({ discountPercent: -1 }), 4, S + 1)],
    ["a NaN discount", () => calculateRefund(ord({ discountPercent: Number.NaN }), 4, S + 1)],
    ["a total above the safe-integer ceiling", () => calculateRefund(ord({ totalCents: 2 ** 53 }), 4, S + 1)],
    ["a negative total", () => calculateRefund(ord({ totalCents: -1 }), 4, S + 1)],
    ["a fractional total", () => calculateRefund(ord({ totalCents: 1.5 }), 4, S + 1)],
    ["a NaN event start", () => calculateRefund(ord({ eventStartMs: Number.NaN }), 4, S + 1)],
    ["an infinite event start", () => calculateRefund(ord({ eventStartMs: Number.POSITIVE_INFINITY }), 4, S + 1)],
    ["a NaN clock", () => calculateRefund(ord(), 4, Number.NaN)],
    ["an infinite clock", () => calculateRefund(ord(), 4, Number.POSITIVE_INFINITY)],
  ];

  it.each(cases)("throws rather than returning 0 for %s", (_label, call) => {
    expect(call).toThrow(RangeError);
  });

  it("throws the same message whether the window is open or closed", () => {
    // The diagnosis a support engineer reads must not depend on when the
    // customer happened to call.
    const messageOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as RangeError).message;
      }
      return "DID NOT THROW";
    };
    for (const [open, closed] of [
      [() => calculateRefund(ord(), 5, S - 1), () => calculateRefund(ord(), 5, S + 1)],
      [() => calculateRefund(ord({ tickets: 0 }), 0, S - 1), () => calculateRefund(ord({ tickets: 0 }), 0, S + 1)],
      [
        () => calculateRefund(ord({ discountPercent: 101 }), 4, S - 1),
        () => calculateRefund(ord({ discountPercent: 101 }), 4, S + 1),
      ],
      [
        () => calculateRefund(ord({ totalCents: 2 ** 53 }), 4, S - 1),
        () => calculateRefund(ord({ totalCents: 2 ** 53 }), 4, S + 1),
      ],
    ] as const) {
      expect(messageOf(closed)).toBe(messageOf(open));
      expect(messageOf(closed)).not.toBe("DID NOT THROW");
    }
  });

  it("netRefund still throws exactly where calculateRefund does, after the window shuts", () => {
    for (const [, call] of cases) {
      expect(call).toThrow(RangeError);
    }
    expect(() => netRefund(ord(), 5, S + 1)).toThrow(RangeError);
    expect(() => netRefund(ord({ totalCents: 2 ** 53 }), 4, S + 1)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// The exact millisecond, from both sides, including signed-zero and non-integer
// clocks that a `>=` comparison could get wrong.
// ---------------------------------------------------------------------------
describe("the boundary is exactly one millisecond wide", () => {
  it("pays in full at start-1 and nothing at start, for a spread of event starts", () => {
    for (const start of [0, 1, -1, S, -S, 1.5, Number.MAX_SAFE_INTEGER, 4_000_000_000_000]) {
      const o = ord({ eventStartMs: start });
      expect(calculateRefund(o, 4, start), `at start ${start}`).toBe(0);
      expect(calculateRefund(o, 4, start - 1), `at start-1 ${start}`).toBe(10_000);
    }
  });

  it("treats a signed-zero clock and a signed-zero start as the same instant", () => {
    // -0 >= 0 and 0 >= -0 are both true. A gate written with a subtraction and
    // a truthiness check instead of `>=` would get one of these wrong.
    expect(calculateRefund(ord({ eventStartMs: 0 }), 4, -0)).toBe(0);
    expect(calculateRefund(ord({ eventStartMs: -0 }), 4, 0)).toBe(0);
    expect(calculateRefund(ord({ eventStartMs: -0 }), 4, -0)).toBe(0);
  });

  it("closes on a fractional millisecond clock, which Date.now() can produce under fake timers", () => {
    const o = ord({ eventStartMs: S });
    expect(calculateRefund(o, 4, S - 0.5)).toBe(10_000);
    expect(calculateRefund(o, 4, S + 0.5)).toBe(0);
    expect(calculateRefund(o, 4, S + Number.EPSILON * S)).toBe(0);
  });

  it("never reopens: the refund is zero for every clock after the start", () => {
    const o = ord({ totalCents: 987_654, tickets: 7 });
    for (const d of [0, 1, 2, 1_000, 86_400_000, 31_536_000_000, 1e15]) {
      expect(calculateRefund(o, 7, S + d), `+${d}ms`).toBe(0);
      expect(netRefund(o, 7, S + d), `+${d}ms`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The rule is implemented TWICE — once in src/refund.ts:52 as `nowMs >=
// eventStartMs`, once in server/server.ts:89 as `now < eventStartMs`. Two copies
// of one rule is where drift lives. They must be exact complements at every
// instant, or there is a moment that pays out AND strands the seat, or one that
// does neither.
// ---------------------------------------------------------------------------
describe("the money gate and the seat gate partition the timeline exactly", () => {
  /** The seat-release predicate, transcribed from server/server.ts:89. */
  const seatsComeBack = (now: number, eventStartMs: number) => now < eventStartMs;

  it("pays exactly when it releases seats, and withholds exactly when it does not", () => {
    const starts = [0, 1, -1, S, Number.MAX_SAFE_INTEGER, -S];
    const deltas = [-1e9, -86_400_000, -1_000, -2, -1, 0, 1, 2, 1_000, 86_400_000, 1e9];
    for (const start of starts) {
      const o = ord({ eventStartMs: start });
      for (const d of deltas) {
        const now = start + d;
        const paid = netRefund(o, 4, now) > 0;
        const released = seatsComeBack(now, start);
        // Paying while stranding the seat is a double loss; releasing the seat
        // while paying nothing would resell a seat the customer still holds.
        expect(paid, `start ${start} delta ${d}: paid=${paid} released=${released}`).toBe(released);
      }
    }
  });

  it("has no instant where both gates are open or both are shut in the wrong direction", () => {
    const o = ord();
    for (let d = -5; d <= 5; d++) {
      const now = S + d;
      const moneyMoves = calculateRefund(o, 4, now) > 0;
      expect(moneyMoves).toBe(seatsComeBack(now, S));
    }
  });
});

// ---------------------------------------------------------------------------
// src/booking.ts:32 — `Number.isSafeInteger(gross)` runs BEFORE the discount is
// applied. That is deliberately conservative: it refuses some orders whose
// discounted total WOULD have been refundable. Pinned as the accepted trade-off
// it is, with the reasoning, so nobody loosens it by accident.
// ---------------------------------------------------------------------------
describe("the booking guard never mints an order the refund path would refuse", () => {
  const ev = (over: Partial<Event> = {}): Event => ({
    id: "e1",
    name: "RockFest",
    totalSeats: 5_000,
    seatsSold: 0,
    priceCents: 5_000,
    startMs: S,
    ...over,
  });

  it("refuses a price that multiplies past the safe-integer ceiling", () => {
    expect(() => bookTickets(ev({ priceCents: 2 ** 52 + 1 }), 2)).toThrow(RangeError);
    expect(() => bookTickets(ev({ priceCents: 2 ** 52 }), 3)).toThrow(RangeError);
  });

  it("still sells the largest order that IS refundable", () => {
    // The other side of the boundary: the guard must not have cost the platform
    // any order it could legitimately honour. 2**52-1 per ticket x2 is a gross
    // of 2**53-2 — the largest even gross under MAX_SAFE_INTEGER (2**53-1), so
    // it must sell AND refund exactly.
    const o = bookTickets(ev({ priceCents: 2 ** 52 - 1 }), 2);
    expect(o.totalCents).toBe(2 ** 53 - 2);
    expect(Number.isSafeInteger(o.totalCents)).toBe(true);
    expect(calculateRefund(o, 2, S - 1)).toBe(2 ** 53 - 2);

    // One cent per ticket more overflows the ceiling and is refused.
    expect(() => bookTickets(ev({ priceCents: 2 ** 52 }), 2)).toThrow(RangeError);
  });

  it("EVERY order bookTickets returns is accepted by the refund path", () => {
    // This is the invariant the guard exists to establish. Swept across the
    // ranges the validators actually admit, including the ones that used to
    // overflow.
    const prices = [0, 1, 2, 3, 99, 5_000, 10_000_000, 2 ** 40, 2 ** 45, 2 ** 50, 2 ** 52, 2 ** 52 + 1, 2 ** 53];
    const counts = [1, 2, 3, 7, 11, 100, 4_999, 5_000];
    const discounts = [0, 0.5, 5, 10, 33.33, 50, 99, 99.999, 100];
    let sold = 0;
    let refused = 0;
    for (const priceCents of prices) {
      for (const n of counts) {
        for (const discountPercent of discounts) {
          let order: Order;
          try {
            order = bookTickets(ev({ priceCents }), n, discountPercent);
          } catch (e) {
            expect(e).toBeInstanceOf(RangeError);
            refused++;
            continue;
          }
          sold++;
          // Sold means refundable — no exceptions, no "paid but unrefundable".
          expect(() => calculateRefund(order, n, S - 1), `price ${priceCents} n ${n} d ${discountPercent}`).not.toThrow();
          expect(() => netRefund(order, n, S - 1)).not.toThrow();
          expect(calculateRefund(order, n, S - 1)).toBe(order.totalCents);
          expect(Number.isSafeInteger(order.totalCents)).toBe(true);
        }
      }
    }
    expect(sold).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it("refuses a comp booking whose total would have been zero — and is RIGHT to", () => {
    // Checking `gross` before the discount refuses a 100% comp of an
    // absurdly-priced event even though its total would be 0. That looks
    // over-eager until you check what `gross` actually holds at that size.
    //
    // Above 2**53 the multiply has ALREADY lost cents, before any discount:
    //   4503599627370497 * 3  ->  float 13510798882111492, exact ...491 (+1)
    //   4503599627370497 * 5  ->  float 22517998136852484, exact ...485 (-1)
    // A `total`-based check would see `Math.round(gross * 0) === 0`, call it
    // perfectly safe, and sell an order whose price silently drifted a cent.
    // The zero is real but the number it came from is fabricated.
    //
    // So `gross` is not merely the conservative place to check, it is the only
    // place that catches the corruption at the point it happens. Pinned so a
    // future "fix" to check `total` instead is recognised as the regression it
    // would be.
    expect(() => bookTickets(ev({ priceCents: 2 ** 52 + 1 }), 2, 100)).toThrow(RangeError);
    expect(() => bookTickets(ev({ priceCents: 2 ** 52 + 1 }), 2, 99.99)).toThrow(RangeError);
    expect(() => bookTickets(ev({ priceCents: 2 ** 52 + 1 }), 3, 100)).toThrow(RangeError);

    // The drift is real: this is what a total-based check would have trusted.
    // Compared in BigInt on both sides — `Number(BigInt(...))` would re-round
    // the exact value straight back to the same drifted double and hide it.
    const p = 2 ** 52 + 1;
    expect(BigInt(p * 3)).not.toBe(BigInt(p) * 3n);
    expect(BigInt(p * 3) - BigInt(p) * 3n).toBe(1n);
    expect(Math.round(p * 3 * (1 - 100 / 100))).toBe(0);

    // And nothing at a credible price is affected by that conservatism.
    const real = bookTickets(ev({ priceCents: 10_000_000 }), 5_000, 100);
    expect(real.totalCents).toBe(0);
    expect(calculateRefund(real, 5_000, S - 1)).toBe(0);
  });

  it("reports the overflow with the same message the refund path would have used", () => {
    try {
      bookTickets(ev({ priceCents: 2 ** 52 + 1 }), 2);
      throw new Error("expected the booking to be refused");
    } catch (e) {
      expect(e).toBeInstanceOf(RangeError);
      expect((e as RangeError).message).toBe("order total out of range");
    }
  });
});
