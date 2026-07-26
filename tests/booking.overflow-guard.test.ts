// The booking overflow guard, attacked.
//
// src/booking.ts refuses a sale whose gross exceeds Number.MAX_SAFE_INTEGER.
// The check runs on `gross`, BEFORE the discount is applied. That is
// deliberately conservative — it refuses some orders whose discounted total
// would have been representable — and the reasoning is pinned below so nobody
// loosens it by accident.
import { describe, it, expect } from "vitest";
import { calculateRefund, netRefund, Order } from "../src/refund";
import { bookTickets, Event } from "../src/booking";

const S = 1_700_000_000_000;


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
