// Boundary-first suite for the booking money path. Every input guard is
// exercised one clause at a time (a single bad value cannot tell you which
// rule fired), every rejection asserts the exact message a customer sees, and
// the seat/discount/price edges — last seat, 100% comp, free event — are
// pinned as the legal cases they are, not left to inference.
import { describe, it, expect } from "vitest";
import { seatsAvailable, bookTickets, groupDiscount } from "../src/booking";

const ev = () => ({ id: "e1", name: "RockFest", totalSeats: 100, seatsSold: 40, priceCents: 5000, startMs: 2000000000000 });

/**
 * Asserts the call is rejected with exactly this message. `toThrow(substring)`
 * is not enough: `toThrow("")` passes against any error, so a blanked-out
 * message would still look green while the customer sees nothing.
 */
function expectRejection(fn: () => unknown, message: string) {
  let thrown: unknown = undefined;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "expected the booking to be rejected, but it went through").toBeInstanceOf(RangeError);
  expect((thrown as RangeError).message).toBe(message);
}

describe("seatsAvailable", () => {
  it("returns remaining seats", () => {
    expect(seatsAvailable(ev())).toBe(60);
  });
  it("returns 0 for a sold-out event", () => {
    expect(seatsAvailable({ ...ev(), seatsSold: 100 })).toBe(0);
  });
  it("reports 0 — never a negative count — for an oversold event", () => {
    // The venue double-sold 5 seats. Availability must clamp at 0: a negative
    // count read as capacity elsewhere would let the oversell grow.
    expect(seatsAvailable({ ...ev(), totalSeats: 100, seatsSold: 105 })).toBe(0);
  });
});

describe("bookTickets — ticket count", () => {
  it("books two tickets at full price", () => {
    const o = bookTickets(ev(), 2);
    expect(o.totalCents).toBe(10000);
    expect(o.tickets).toBe(2);
  });
  it("rejects zero tickets with the customer-facing reason", () => {
    expectRejection(() => bookTickets(ev(), 0), "must book at least one whole ticket");
  });
  it("rejects a fraction of a ticket", () => {
    expectRejection(() => bookTickets(ev(), 2.5), "must book at least one whole ticket");
  });
  it("rejects a negative ticket count, which would otherwise pay the customer", () => {
    expectRejection(() => bookTickets(ev(), -2), "must book at least one whole ticket");
  });
});

describe("bookTickets — discount", () => {
  it("applies a percentage discount", () => {
    const o = bookTickets(ev(), 2, 50);
    expect(o.totalCents).toBe(5000);
  });
  // Each of the three discount rules is tripped alone, so a broken rule cannot
  // hide behind one of the others.
  it("rejects a discount that is not a number at all (NaN slips past < and >)", () => {
    expectRejection(() => bookTickets(ev(), 2, Number.NaN), "discount out of range");
  });
  it("rejects a negative discount, which would charge above list price", () => {
    expectRejection(() => bookTickets(ev(), 2, -10), "discount out of range");
  });
  it("rejects a discount over 100%, which would pay the customer to attend", () => {
    expectRejection(() => bookTickets(ev(), 2, 150), "discount out of range");
  });
  it("accepts a 100% comp booking and charges nothing", () => {
    // 100 is the top of the legal range, not past it: comp tickets are a real
    // product and must not be rejected at the boundary.
    const o = bookTickets(ev(), 2, 100);
    expect(o.totalCents).toBe(0);
    expect(o.tickets).toBe(2);
  });
  it("charges whole cents when a discount lands on half a cent", () => {
    // 50% of 101 cents is 50.5 — the customer is billed 51, never a fraction.
    const o = bookTickets({ ...ev(), priceCents: 101 }, 1, 50);
    expect(o.totalCents).toBe(51);
  });
});

describe("bookTickets — event data", () => {
  it("refuses to sell an event whose price is not whole cents", () => {
    expectRejection(() => bookTickets({ ...ev(), priceCents: 4999.5 }, 2), "event price out of range");
  });
  it("refuses to sell an event with a negative price", () => {
    expectRejection(() => bookTickets({ ...ev(), priceCents: -5000 }, 2), "event price out of range");
  });
  it("sells a free event for nothing instead of rejecting it", () => {
    const o = bookTickets({ ...ev(), priceCents: 0 }, 3);
    expect(o.totalCents).toBe(0);
    expect(o.tickets).toBe(3);
  });
  it("refuses to sell an event with no usable start time", () => {
    // The start time is the refund deadline. Selling without one leaves the
    // refund window undefined for the life of the order.
    expectRejection(() => bookTickets({ ...ev(), startMs: Number.NaN }, 2), "event start out of range");
  });
  it("stamps the order with the event start so refunds have a deadline", () => {
    const o = bookTickets(ev(), 2, 25);
    expect(o.eventStartMs).toBe(2000000000000);
    expect(o.discountPercent).toBe(25);
  });
});

describe("bookTickets — capacity", () => {
  it("sells the last remaining seats", () => {
    // 60 left, 60 asked for: the venue must not strand its final seats.
    const o = bookTickets(ev(), 60);
    expect(o.tickets).toBe(60);
    expect(o.totalCents).toBe(300000);
  });
  it("rejects one seat more than the house holds, with the reason", () => {
    expectRejection(() => bookTickets(ev(), 61), "not enough seats");
  });
  it("rejects any booking against a sold-out event", () => {
    expectRejection(() => bookTickets({ ...ev(), seatsSold: 100 }, 1), "not enough seats");
  });
});

describe("groupDiscount", () => {
  it("gives no discount for small groups", () => {
    expect(groupDiscount(2)).toBe(0);
  });
  it("gives 5% for groups of five", () => {
    expect(groupDiscount(5)).toBe(5);
  });
  it("gives 10% for groups of ten", () => {
    expect(groupDiscount(10)).toBe(10);
  });
  it("keeps a group just below a tier on the lower rate", () => {
    expect(groupDiscount(4)).toBe(0);
    expect(groupDiscount(9)).toBe(5);
  });
});
