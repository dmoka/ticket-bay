// The safe-integer ceiling on a NEW order (src/booking.ts:32).
//
// `calculateRefund` refuses any total above Number.MAX_SAFE_INTEGER
// (src/refund.ts:39). Without the guard in `bookTickets`, an event priced high
// enough that `priceCents * n` multiplies past that ceiling is still SOLD — the
// customer pays, and the refund path then refuses that order forever. Measured:
// a 2-ticket booking at 4503599627370496 cents produces a total of
// 9007199254740992, and `calculateRefund` answers "order total out of range" for
// the rest of that order's life.
//
// So both sides of the ceiling are pinned. Over it, the sale is refused before
// any money changes hands. Exactly on it, the sale must still go through — a
// guard that creeps one cent tighter starts refusing orders the refund path
// handles perfectly well.
import { describe, it, expect } from "vitest";
import { bookTickets, Event } from "../src/booking";
import { calculateRefund } from "../src/refund";

const MAX = Number.MAX_SAFE_INTEGER; // 9007199254740991

/** A hall large enough that capacity is never the reason a booking is refused. */
const ev = (over: Partial<Event> = {}): Event => ({
  id: "e1",
  name: "RockFest",
  totalSeats: 10_000,
  seatsSold: 0,
  priceCents: 5_000,
  startMs: 2_000_000_000_000,
  ...over,
});

/**
 * Asserts the booking is refused with exactly this message — the same standard
 * tests/booking.test.ts holds every other rejection to. `toThrow(substring)`
 * would pass against a blanked-out message, leaving a refused customer with
 * nothing on screen explaining why.
 */
function expectRejection(fn: () => unknown, message: string) {
  let thrown: unknown = undefined;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "expected the booking to be refused, but it went through").toBeInstanceOf(RangeError);
  expect((thrown as RangeError).message).toBe(message);
}

describe("an order too large to refund is never sold", () => {
  it("refuses a booking whose total lands one step past the safe-integer ceiling", () => {
    // 4503599627370496 x 2 = 9007199254740992 = 2^53. Representable as a double,
    // but one past the largest total calculateRefund will accept.
    expectRejection(
      () => bookTickets(ev({ priceCents: 2 ** 52 }), 2),
      "order total out of range",
    );
  });

  it("refuses a booking whose total overflows the safe-integer range outright", () => {
    expectRejection(() => bookTickets(ev({ priceCents: MAX }), 2), "order total out of range");
  });

  it("refuses it on the quantity as well as the price — 3 tickets at a third of the ceiling", () => {
    // The overflow comes from the multiplication, so a modest price and a large
    // group has to be caught the same way an extreme price is.
    expectRejection(() => bookTickets(ev({ priceCents: 3_500_000_000_000_000 }), 3), "order total out of range");
  });

  it("a discount does not rescue an order whose gross already overflowed", () => {
    // The guard runs on `gross`, before the discount is applied. A 100% comp on
    // an overflowing gross must still be refused, not quietly discounted down
    // into range — the event is mispriced and the sale is the bug.
    expectRejection(() => bookTickets(ev({ priceCents: MAX }), 2, 100), "order total out of range");
  });
});

describe("every order that IS sold can still be refunded", () => {
  it("sells an order whose total lands exactly on the ceiling, and refunds it in full", () => {
    // 1416003655831 x 6361 = 9007199254740991 exactly, the largest total the
    // refund path accepts. This is the boundary from the paying side: tighten
    // the guard and a legitimate sale starts being refused.
    const order = bookTickets(ev({ priceCents: 1_416_003_655_831 }), 6_361);
    expect(order.totalCents).toBe(MAX);

    // The whole reason the guard exists: what was sold must be refundable.
    expect(calculateRefund(order, order.tickets, order.eventStartMs - 1)).toBe(MAX);
  });

  it("refunds an ordinary large booking in full rather than refusing it", () => {
    const order = bookTickets(ev({ priceCents: 1_000_000_000 }), 1_000);
    expect(order.totalCents).toBe(1_000_000_000_000);
    expect(calculateRefund(order, order.tickets, order.eventStartMs - 1)).toBe(1_000_000_000_000);
  });
});
