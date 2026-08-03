// Adversarial lane, round 2 — the refund window after the gate landed.
//
// Round 1 (refund.post-event-cutoff.adversarial.test.ts) showed the gate was
// missing entirely. It is there now: `nowMs >= order.eventStartMs -> 0`. This
// file attacks the fix rather than the hole it filled, in three directions:
//
//   1. A closed window must not swallow a bad call. src/refund.ts:53-54 makes
//      that promise in its own words — "Out-of-range input still throws above:
//      a closed window closes the money, it does not excuse a bad call" — and
//      NOTHING in the suite checks it. Every existing rejection test
//      (refund.validation.test.ts, refund.property.test.ts:696) runs on a clock
//      BEFORE the event; the closed-window generator in
//      refund.timegate.property.test.ts only ever builds VALID orders
//      (`cancelled: fc.integer({ min: 0, max: order.tickets })`). Move the gate
//      three lines up, above the validators, and the whole suite stays green
//      while `calculateRefund(order, -5, afterTheShow)` starts answering 0
//      instead of throwing — a caller's off-by-one silently becoming "no refund
//      owed" instead of a loud error.
//
//   2. The gate must not have closed the window EARLY. The open side is
//      re-asserted here with hand-computed amounts, not by re-deriving them
//      from the implementation, on the order shapes that actually round badly.
//
//   3. The fee floor either side of the gate, at the cents where it turns over.
//
// Amounts below are worked out by hand and written as literals on purpose. A
// test that recomputes `total * cancelled / tickets` agrees with the code by
// construction and would agree with it while it was wrong.
import { describe, it, expect } from "vitest";
import { calculateRefund, netRefund, refundFee, Order } from "../src/refund";

const START = 1_700_000_000_000;
const HOUR = 3_600_000;

const ord = (o: Partial<Order> = {}): Order => ({
  totalCents: 10_000,
  tickets: 4,
  discountPercent: 0,
  eventStartMs: START,
  ...o,
});

/** Clocks on the closed side of the window, including the start instant. */
const CLOSED = [START, START + 1, START + HOUR, START + 365 * 24 * HOUR];

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return "<did not throw>";
}

// ---------------------------------------------------------------------------
// 1. A closed window closes the money — it does not excuse a bad call.
// ---------------------------------------------------------------------------
describe("the closed window still rejects what the open window rejects", () => {
  const badCalls: Array<[string, () => unknown, string]> = [
    [
      "more tickets cancelled than the order holds",
      () => calculateRefund(ord(), 5, CLOSED[0]),
      "cancelled tickets out of range",
    ],
    ["a negative cancellation", () => calculateRefund(ord(), -1, CLOSED[1]), "cancelled tickets out of range"],
    ["half a ticket cancelled", () => calculateRefund(ord(), 1.5, CLOSED[2]), "cancelled tickets out of range"],
    ["an unreadable cancellation", () => calculateRefund(ord(), Number.NaN, CLOSED[3]), "cancelled tickets out of range"],
    [
      "an order with no tickets",
      () => calculateRefund(ord({ tickets: 0 }), 0, CLOSED[0]),
      "order must have at least one ticket",
    ],
    [
      "an order with a fractional ticket count",
      () => calculateRefund(ord({ tickets: 2.5 }), 2, CLOSED[1]),
      "order must have at least one ticket",
    ],
    [
      "a discount above 100%",
      () => calculateRefund(ord({ discountPercent: 101 }), 4, CLOSED[2]),
      "discount out of range",
    ],
    [
      "an unreadable discount",
      () => calculateRefund(ord({ discountPercent: Number.NaN }), 4, CLOSED[3]),
      "discount out of range",
    ],
    [
      "a total past the safe-integer ceiling",
      () => calculateRefund(ord({ totalCents: 2 ** 53 }), 4, CLOSED[0]),
      "order total out of range",
    ],
    ["a negative total", () => calculateRefund(ord({ totalCents: -1 }), 4, CLOSED[1]), "order total out of range"],
    [
      "a total that is not a whole number of cents",
      () => calculateRefund(ord({ totalCents: 10.5 }), 4, CLOSED[2]),
      "order total out of range",
    ],
    [
      "an unreadable event start",
      () => calculateRefund(ord({ eventStartMs: Number.NaN }), 4, CLOSED[3]),
      "event start out of range",
    ],
    [
      "a clock at positive infinity — later than every event, and still not a clock",
      () => calculateRefund(ord(), 4, Number.POSITIVE_INFINITY),
      "current time out of range",
    ],
  ];

  it.each(badCalls)("throws on %s even though the event has started", (_label, call, message) => {
    expect(call).toThrow(RangeError);
    expect(messageOf(call)).toBe(message);
  });

  // The same, one layer up. netRefund reads the gate through calculateRefund,
  // so a gate moved above the validators would silence it here too.
  it("netRefund rejects the same bad calls after the event", () => {
    expect(() => netRefund(ord(), 5, START + HOUR)).toThrow(RangeError);
    expect(() => netRefund(ord({ tickets: 0 }), 0, START + HOUR)).toThrow(RangeError);
    expect(() => netRefund(ord({ totalCents: 2 ** 53 }), 4, START + HOUR)).toThrow(RangeError);
    expect(messageOf(() => netRefund(ord({ discountPercent: -1 }), 4, START + HOUR))).toBe("discount out of range");
  });
});

// ---------------------------------------------------------------------------
// 2. The window did not close early: the open side, to the cent.
// ---------------------------------------------------------------------------
describe("a customer who cancelled in time is still paid in full", () => {
  // [label, order, cancelled, expected refund, expected net]
  // Every number below is arithmetic done by hand from the documented rule:
  // share = round-half-up(totalCents * cancelled / tickets),
  // fee   = min(share, max(50, round-half-up(2% of share))).
  const shapes: Array<[string, Order, number, number, number]> = [
    ["a one-cent order, whole", ord({ totalCents: 1, tickets: 1 }), 1, 1, 0],
    ["300 tickets sharing 150 cents, one ticket", ord({ totalCents: 150, tickets: 300 }), 1, 1, 0],
    ["300 tickets sharing 150 cents, all of them", ord({ totalCents: 150, tickets: 300 }), 300, 150, 100],
    ["10000 over 3, one ticket (rounds down)", ord({ totalCents: 10_000, tickets: 3 }), 1, 3_333, 3_266],
    ["10000 over 3, two tickets (rounds up)", ord({ totalCents: 10_000, tickets: 3 }), 2, 6_667, 6_534],
    ["10000 over 3, all three (exact)", ord({ totalCents: 10_000, tickets: 3 }), 3, 10_000, 9_800],
    ["10001 over 3, one ticket", ord({ totalCents: 10_001, tickets: 3 }), 1, 3_334, 3_267],
    ["10001 over 3, two tickets", ord({ totalCents: 10_001, tickets: 3 }), 2, 6_667, 6_534],
    ["a 99.5% discounted order, 3 of 10", ord({ totalCents: 50, tickets: 10, discountPercent: 99.5 }), 3, 15, 0],
    ["a 100% discounted free order", ord({ totalCents: 0, tickets: 4, discountPercent: 100 }), 4, 0, 0],
    [
      "the largest admitted total over 3, two tickets",
      ord({ totalCents: Number.MAX_SAFE_INTEGER, tickets: 3 }),
      2,
      6_004_799_503_160_661,
      5_884_703_513_097_448,
    ],
  ];

  it.each(shapes)("pays %s one millisecond before the doors open", (_label, order, cancelled, gross, net) => {
    expect(calculateRefund(order, cancelled, order.eventStartMs - 1)).toBe(gross);
    expect(netRefund(order, cancelled, order.eventStartMs - 1)).toBe(net);
  });

  // The same shapes on the closed side: not one cent moves.
  it.each(shapes)("pays nothing for %s once the event has started", (_label, order, cancelled) => {
    expect(calculateRefund(order, cancelled, order.eventStartMs)).toBe(0);
    expect(netRefund(order, cancelled, order.eventStartMs + HOUR)).toBe(0);
  });

  // Splitting a cancellation across the boundary is not a way to be paid twice:
  // whatever was collected in time plus whatever is collected afterwards can
  // never exceed the amount paid. The shapes above include the ones documented
  // at src/refund.ts:22-27 as overpaying when refunded one ticket at a time, so
  // this is the case where an escape would show.
  it("cannot be topped up after the show by splitting the cancellation", () => {
    for (const [, order] of shapes.map((s) => [s[0], s[1]] as const)) {
      for (const inTime of [0, 1, order.tickets - 1, order.tickets]) {
        const paid = calculateRefund(order, inTime, order.eventStartMs - 1);
        const after = calculateRefund(order, order.tickets - inTime, order.eventStartMs);
        expect(after).toBe(0);
        expect(paid + after).toBeLessThanOrEqual(order.totalCents);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The fee floor, at the cents where it turns over.
// ---------------------------------------------------------------------------
describe("the 50-cent floor and the 2% rate, cent by cent", () => {
  // [refund, expected fee]. The floor binds up to 2500 cents, where 2% first
  // reaches 50; above it the rate binds. 2525 is the first amount whose 2%
  // lands exactly on half a cent (50.5) and so exposes the rounding direction.
  const fees: Array<[number, number]> = [
    [0, 0],
    [1, 1],
    [49, 49],
    [50, 50],
    [51, 50],
    [100, 50],
    [2_499, 50],
    [2_500, 50],
    [2_501, 50],
    [2_524, 50],
    [2_525, 51],
    [2_550, 51],
    [10_000, 200],
    [Number.MAX_SAFE_INTEGER, 180_143_985_094_820],
  ];

  it.each(fees)("keeps %i cents -> a fee of %i", (refund, fee) => {
    expect(refundFee(refund)).toBe(fee);
  });

  // Negative and unreadable amounts are not refunds, so there is no fee to take.
  it.each([[-1], [-2_500], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]])(
    "keeps nothing from %s",
    (bad) => {
      expect(refundFee(bad)).toBe(0);
    },
  );

  // The floor never turns a refund into a charge, on either side of the window.
  it("never hands the customer a negative amount", () => {
    for (const cents of [1, 25, 49, 50, 51, 2_500]) {
      const order = ord({ totalCents: cents, tickets: 1 });
      expect(netRefund(order, 1, START - 1)).toBeGreaterThanOrEqual(0);
      expect(netRefund(order, 1, START)).toBe(0);
    }
  });
});
