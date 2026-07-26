// Adversarial lane — the refund time gate.
//
// src/refund.ts:16-17 states the rule in the docstring of calculateRefund:
//
//     "Business rule: cancellations are only allowed BEFORE the event starts.
//      From `eventStartMs` on, the refund is zero."
//
// and src/refund.ts:8 repeats it on the field itself: "refunds close at this
// moment". The function validates `nowMs` (src/refund.ts:47) and `eventStartMs`
// (src/refund.ts:42) and then never compares them — `exactShare` is reached
// unconditionally. Every existing test in every lane evaluates the refund
// STRICTLY BEFORE the start: tests/refund.property.ts builds a `strictlyBefore`
// helper and even threads a ULP-walking `previousDouble` through it so the clock
// can never land ON the boundary, and tests/refund.arithmetic.test.ts and
// tests/refund.validation.test.ts use a `BEFORE = S - 1` constant throughout.
// The rule is therefore documented, plumbed through four layers, and asserted
// nowhere.
//
// These tests pin the documented behaviour. They are expected to FAIL against
// the current source. Do not weaken them; the gate belongs in src/refund.ts.
import { describe, it, expect } from "vitest";
import { calculateRefund, netRefund, Order } from "../src/refund";
import { bookTickets, groupDiscount } from "../src/booking";

const S = 1_700_000_000_000; // event start
const HOUR = 3_600_000;
const ord = (o: Partial<Order> = {}): Order => ({
  totalCents: 10_000,
  tickets: 4,
  discountPercent: 0,
  eventStartMs: S,
  ...o,
});

describe("the refund window closes AT the event start", () => {
  // The docstring says "From `eventStartMs` on" — inclusive. This is the exact
  // boundary the whole rule turns on, and it is the one instant no existing
  // test visits.
  it("refunds zero at exactly the event start", () => {
    expect(calculateRefund(ord(), 4, S)).toBe(0);
  });

  it("refunds zero one millisecond after the event start", () => {
    expect(calculateRefund(ord(), 4, S + 1)).toBe(0);
  });

  it("still refunds in full one millisecond before the event start", () => {
    // The other side of the boundary: a gate implemented as `>` instead of `>=`
    // would pass the two tests above and break this one, and vice versa. Both
    // sides are pinned so the fix has to land on the exact millisecond.
    expect(calculateRefund(ord(), 4, S - 1)).toBe(10_000);
  });

  it("refunds zero a day, a month and a year after the event", () => {
    for (const late of [24 * HOUR, 30 * 24 * HOUR, 365 * 24 * HOUR]) {
      expect(calculateRefund(ord(), 4, S + late)).toBe(0);
    }
  });

  it("refunds zero on a PARTIAL cancellation after the event start", () => {
    // Cancelling 1 of 4 after the show is the same closed window as cancelling
    // all 4. Nothing about the gate is proportional.
    expect(calculateRefund(ord(), 1, S + 1)).toBe(0);
    expect(calculateRefund(ord(), 3, S + HOUR)).toBe(0);
  });

  it("closes the window for an event that started before the epoch too", () => {
    // eventStartMs is only validated as finite, so negative starts are in-spec.
    const past = ord({ eventStartMs: -1_000 });
    expect(calculateRefund(past, 4, -1_000)).toBe(0);
    expect(calculateRefund(past, 4, 0)).toBe(0);
    expect(calculateRefund(past, 4, -1_001)).toBe(10_000);
  });

  it("closes the window at the top of the admitted money range as well", () => {
    const rich = ord({ totalCents: Number.MAX_SAFE_INTEGER });
    expect(calculateRefund(rich, 4, S)).toBe(0);
    expect(calculateRefund(rich, 4, S - 1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("still rejects malformed input after the window closes, rather than quietly paying zero", () => {
    // A closed window must not become a way to smuggle bad orders through: the
    // validators still fire, they just no longer lead to a payout.
    expect(() => calculateRefund(ord(), 5, S + 1)).toThrow(RangeError);
    expect(() => calculateRefund(ord({ tickets: 0 }), 0, S + 1)).toThrow(RangeError);
    expect(() => calculateRefund(ord({ discountPercent: 101 }), 4, S + 1)).toThrow(RangeError);
    expect(() => calculateRefund(ord(), 4, Number.NaN)).toThrow(RangeError);
  });
});

describe("netRefund carries the closed window through the fee layer", () => {
  it("pays the customer nothing at exactly the event start", () => {
    expect(netRefund(ord(), 4, S)).toBe(0);
  });

  it("pays the customer nothing after the event start", () => {
    expect(netRefund(ord(), 4, S + HOUR)).toBe(0);
    expect(netRefund(ord({ totalCents: 45_000, tickets: 10 }), 10, S + 1)).toBe(0);
  });

  it("still pays in full one millisecond before the event start", () => {
    expect(netRefund(ord(), 4, S - 1)).toBe(9_800);
  });
});

describe("the gate holds on orders that came out of the real booking path", () => {
  const event = { id: "rockfest", name: "RockFest", totalSeats: 100, seatsSold: 40, priceCents: 5_000, startMs: S };

  it("a group booking cancelled after the show gets nothing back", () => {
    // The same 10-ticket group order e2e/refund-money-paths.spec.ts books:
    // 45000 cents paid, 44100 refunded when cancelled in time.
    const order = bookTickets(event, 10, groupDiscount(10));
    expect(order.totalCents).toBe(45_000);
    expect(netRefund(order, 10, S - 1)).toBe(44_100);
    expect(netRefund(order, 10, S)).toBe(0);
    expect(netRefund(order, 10, S + 1)).toBe(0);
  });

  it("the sold-out order the seat-release spec uses gets nothing back after the show", () => {
    // 60 seats x 5000 less the 10% group tier = 270000; 264600 net in time.
    const order = bookTickets(event, 60, groupDiscount(60));
    expect(order.totalCents).toBe(270_000);
    expect(netRefund(order, 60, S - 1)).toBe(264_600);
    expect(netRefund(order, 60, S + 1)).toBe(0);
  });
});

describe("the clock is the only thing that decides, and it decides monotonically", () => {
  // INVARIANT: the refund can only ever get smaller as time passes. Once the
  // window shuts it stays shut — there is no instant after the start at which
  // money starts flowing again.
  it("the refund never increases as the clock advances", () => {
    const order = ord({ totalCents: 123_457, tickets: 7 });
    const clocks = [S - 1_000_000, S - 1, S, S + 1, S + HOUR, S + 365 * 24 * HOUR];
    let previous = Number.POSITIVE_INFINITY;
    for (const now of clocks) {
      const r = calculateRefund(order, 7, now);
      expect(r).toBeLessThanOrEqual(previous);
      previous = r;
    }
    expect(previous).toBe(0);
  });

  it("is zero for every clock at or after the start, across a spread of orders", () => {
    const orders: Order[] = [
      ord(),
      ord({ totalCents: 1, tickets: 1 }),
      ord({ totalCents: 10_000, tickets: 3 }),
      ord({ totalCents: 45_000, tickets: 10, discountPercent: 10 }),
      ord({ totalCents: 0, tickets: 5, discountPercent: 100 }),
    ];
    for (const o of orders) {
      for (const now of [S, S + 1, S + HOUR, S + 10_000 * HOUR]) {
        expect(calculateRefund(o, o.tickets, now)).toBe(0);
        expect(netRefund(o, o.tickets, now)).toBe(0);
      }
    }
  });
});
