// The refund time window — the rule src/refund.ts promises in prose but never
// executes.
//
// Why this file exists, from the mutation lane specifically:
//
// `npm run test:mutation` scores 95.60% on src/refund.ts with seven survivors,
// every one of them provably unable to change a payout. That number is honest
// about the code that is there and silent about the code that is not. Mutation
// testing mutates statements; a business rule with no statement produces no
// mutant, so an entirely absent rule scores 100%. This is that case.
//
// src/refund.ts:16-17 states the rule:
//   "Business rule: cancellations are only allowed BEFORE the event starts.
//    From `eventStartMs` on, the refund is zero."
//
// `calculateRefund` reads `nowMs` exactly once, to check `Number.isFinite`, and
// reads `order.eventStartMs` exactly once, for the same check. The two are never
// compared. The clock is validated and then ignored, which is what makes the
// omission hard to see by eye: the parameter looks used.
//
// The docstring is the specification. A promise the code does not keep is a
// defect in the code, so these tests are written against the promise.
import { describe, it, expect } from "vitest";
import { calculateRefund, netRefund, Order } from "../src/refund";
import { bookTickets, Event } from "../src/booking";

/** Doors open 1 June 2026, 19:00 UTC. */
const DOORS_OPEN = Date.UTC(2026, 5, 1, 19, 0, 0);
const ONE_MINUTE = 60_000;
const ONE_DAY = 86_400_000;

const order = (over: Partial<Order> = {}): Order => ({
  totalCents: 50_000, // two tickets at 250.00
  tickets: 2,
  discountPercent: 0,
  eventStartMs: DOORS_OPEN,
  ...over,
});

describe("refunds close when the event starts", () => {
  it("pays nothing for a cancellation made the day after the show", () => {
    // The gig has happened. The seats were occupied, the act was paid, the bar
    // took its money. There is nothing left to refund.
    expect(calculateRefund(order(), 2, DOORS_OPEN + ONE_DAY)).toBe(0);
  });

  it("hands the customer nothing, net of fees, after the show", () => {
    expect(netRefund(order(), 2, DOORS_OPEN + ONE_DAY)).toBe(0);
  });

  it("closes at the first instant of the event, not one tick later", () => {
    // "From `eventStartMs` on" — the boundary instant is closed, not open.
    // A customer standing at the door as it opens has missed the window.
    expect(calculateRefund(order(), 2, DOORS_OPEN)).toBe(0);
    expect(netRefund(order(), 2, DOORS_OPEN)).toBe(0);
  });

  it("pays nothing for a partial cancellation after the show either", () => {
    // Cancelling one of two seats after the fact is the same claim, half size.
    expect(calculateRefund(order(), 1, DOORS_OPEN + ONE_MINUTE)).toBe(0);
    expect(netRefund(order(), 1, DOORS_OPEN + ONE_MINUTE)).toBe(0);
  });

  it("pays nothing on a large order after the show, so the exposure is not capped", () => {
    // The same hole on a coach party: 400 seats at 250.00 is 100,000.00 that
    // walks back out of the account after the act has already been paid.
    const party = order({ totalCents: 10_000_000, tickets: 400 });
    expect(calculateRefund(party, 400, DOORS_OPEN + ONE_DAY)).toBe(0);
    expect(netRefund(party, 400, DOORS_OPEN + ONE_DAY)).toBe(0);
  });

  it("still refunds in full for a customer who cancels a minute before doors", () => {
    // The other half of the rule, and the reason this file pins both sides: a
    // gate that closes early robs customers who cancelled in good time. Fixing
    // the rule must not turn a full refund into nothing for this customer.
    expect(calculateRefund(order(), 2, DOORS_OPEN - ONE_MINUTE)).toBe(50_000);
    expect(netRefund(order(), 2, DOORS_OPEN - ONE_MINUTE)).toBe(49_000);
  });

  it("still refunds in full at the last representable instant before doors", () => {
    expect(calculateRefund(order(), 2, DOORS_OPEN - 1)).toBe(50_000);
  });

  it("refuses a real booking's refund once that booking's own event has started", () => {
    // End to end through the code a customer actually goes through: the order
    // carries its event's start time, and that is what closes the window.
    const ev: Event = {
      id: "rockfest",
      name: "RockFest 2026",
      totalSeats: 100,
      seatsSold: 40,
      priceCents: 25_000,
      startMs: DOORS_OPEN,
    };
    const booked = bookTickets(ev, 2);

    expect(calculateRefund(booked, 2, DOORS_OPEN - ONE_DAY)).toBe(booked.totalCents);
    expect(calculateRefund(booked, 2, DOORS_OPEN + ONE_DAY)).toBe(0);
    expect(netRefund(booked, 2, DOORS_OPEN + ONE_DAY)).toBe(0);
  });
});
