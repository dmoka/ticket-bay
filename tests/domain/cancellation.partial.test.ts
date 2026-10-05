// Cancelling some of an order's tickets (src/domain/cancellation.ts): each
// cancel is priced on running totals, so any sequence of partial cancels nets
// exactly what one whole-order cancel would; an event cancellation pays the
// ticket amount for the tickets still held, with no fee.
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  eventCancellationRefund,
  NOTHING_REFUNDED,
  PARTIAL_CANCEL_CLOSED,
  previewCancellation,
  quoteCancellation,
  refundsSoFar,
  type CancellationQuote,
  type RefundsSoFar,
} from "../../src/domain/cancellation";
import { calculateRefund, netRefund, paidShare, refundFee, type Order } from "../../src/domain/refund";

const START = 1_800_000_000_000;
const OPEN = START - 1;
const order = (totalCents: number, tickets: number): Order => ({ totalCents, tickets, discountPercent: 0, eventStartMs: START });

/** Cancel `parts` tickets one cancel after another, all at `nowMs`; every cancel's quote, in order. */
function cancelInParts(o: Order, parts: number[], nowMs = OPEN): { quotes: CancellationQuote[]; soFar: RefundsSoFar } {
  const quotes: CancellationQuote[] = [];
  for (const n of parts) quotes.push(quoteCancellation(o, refundsSoFar(quotes), n, nowMs));
  return { quotes, soFar: refundsSoFar(quotes) };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("quoteCancellation", () => {
  it("cancels one ticket of two: half the tickets part less the fee on that half", () => {
    expect(quoteCancellation(order(10_000, 2), NOTHING_REFUNDED, 1, OPEN)).toEqual({
      tickets: 1,
      windowOpen: true,
      grossCents: 5_000,
      feeCents: 100,
      netCents: 4_900,
      releasesSeats: true,
    });
  });

  it("the second half pays the rest: together exactly the whole-order refund", () => {
    const { quotes, soFar } = cancelInParts(order(10_000, 2), [1, 1]);
    expect(quotes.map((q) => q.netCents)).toEqual([4_900, 4_900]);
    expect(soFar).toEqual({ ticketsCancelled: 2, grossCents: 10_000, feeCents: 200 });
    expect(sum(quotes.map((q) => q.netCents))).toBe(netRefund(order(10_000, 2), 2, OPEN));
  });

  it("quoting everything left with nothing refunded is the whole-order preview", () => {
    const o = order(12_345, 3);
    const { tickets, ...rest } = quoteCancellation(o, NOTHING_REFUNDED, 3, OPEN);
    expect(tickets).toBe(3);
    expect(rest).toEqual(previewCancellation(o, OPEN));
  });

  it("from the event start on a full cancel — every ticket left — pays nothing and keeps the seats, even after earlier refunds", () => {
    const o = order(10_000, 4);
    const closed = { windowOpen: false, grossCents: 0, feeCents: 0, netCents: 0, releasesSeats: false };
    expect(quoteCancellation(o, NOTHING_REFUNDED, 4, START)).toEqual({ tickets: 4, ...closed });
    expect(quoteCancellation(o, { ticketsCancelled: 1, grossCents: 2_500, feeCents: 50 }, 3, START)).toEqual({ tickets: 3, ...closed });
    expect(quoteCancellation(o, { ticketsCancelled: 3, grossCents: 7_500, feeCents: 150 }, 1, START + 1)).toEqual({ tickets: 1, ...closed });
  });

  it("from the event start on a partial cancel is refused", () => {
    const o = order(10_000, 4);
    const soFar = { ticketsCancelled: 1, grossCents: 2_500, feeCents: 50 };
    expect(PARTIAL_CANCEL_CLOSED).toBe("partial cancel after the event has started");
    expect(() => quoteCancellation(o, NOTHING_REFUNDED, 3, START)).toThrow(new RangeError(PARTIAL_CANCEL_CLOSED));
    expect(() => quoteCancellation(o, soFar, 2, START)).toThrow(new RangeError(PARTIAL_CANCEL_CLOSED));
    expect(() => quoteCancellation(o, soFar, 1, START + 1)).toThrow(new RangeError(PARTIAL_CANCEL_CLOSED));
    // The same partial cancel one millisecond earlier is fine.
    expect(quoteCancellation(o, soFar, 2, START - 1)).toMatchObject({ tickets: 2, windowOpen: true, releasesSeats: true });
    // More than are left is still a bad count, not a closed window.
    expect(() => quoteCancellation(o, soFar, 4, START)).toThrow(new RangeError("tickets to cancel out of range"));
  });

  it("the last instant before the start is still inside the window", () => {
    expect(quoteCancellation(order(10_000, 2), NOTHING_REFUNDED, 1, START - 1)).toMatchObject({ windowOpen: true, netCents: 4_900 });
  });

  it("refuses to cancel zero, a fraction, or more tickets than are left", () => {
    const o = order(10_000, 3);
    const soFar = { ticketsCancelled: 1, grossCents: 3_333, feeCents: 67 };
    for (const n of [0, -1, 1.5, 3, Number.NaN]) {
      expect(() => quoteCancellation(o, soFar, n, OPEN), String(n)).toThrow(new RangeError("tickets to cancel out of range"));
    }
    expect(quoteCancellation(o, soFar, 2, OPEN).tickets).toBe(2);
  });

  it("refuses a history that cannot belong to the order", () => {
    const o = order(10_000, 3);
    for (const soFar of [
      { ticketsCancelled: -1, grossCents: 0, feeCents: 0 },
      { ticketsCancelled: 0.5, grossCents: 0, feeCents: 0 },
      { ticketsCancelled: 4, grossCents: 0, feeCents: 0 },
    ]) {
      expect(() => quoteCancellation(o, soFar, 1, OPEN), JSON.stringify(soFar)).toThrow(new RangeError("tickets cancelled so far out of range"));
    }
    for (const soFar of [
      { ticketsCancelled: 1, grossCents: -1, feeCents: 0 },
      { ticketsCancelled: 1, grossCents: 1.5, feeCents: 0 },
      { ticketsCancelled: 1, grossCents: 0, feeCents: -1 },
      { ticketsCancelled: 1, grossCents: 0, feeCents: Number.NaN },
      { ticketsCancelled: 1, grossCents: 2 ** 53, feeCents: 0 },
    ]) {
      expect(() => quoteCancellation(o, soFar, 1, OPEN), JSON.stringify(soFar)).toThrow(new RangeError("refunds so far out of range"));
    }
  });

});

describe("refundsSoFar", () => {
  it("adds up tickets, gross and fees; nothing refunded is all zeros", () => {
    expect(refundsSoFar([])).toEqual(NOTHING_REFUNDED);
    expect(
      refundsSoFar([
        { tickets: 1, grossCents: 500, feeCents: 50 },
        { tickets: 2, grossCents: 1_000, feeCents: 0 },
      ]),
    ).toEqual({ ticketsCancelled: 3, grossCents: 1_500, feeCents: 50 });
  });
});

describe("paidShare", () => {
  it("is calculateRefund without the time gate", () => {
    const o = order(10_001, 3);
    expect(paidShare(o, 1)).toBe(calculateRefund(o, 1, OPEN));
    expect(paidShare(o, 2)).toBe(6_667);
    expect(paidShare(o, 3)).toBe(10_001);
    expect(paidShare(o, 0)).toBe(0);
    expect(calculateRefund(o, 2, START)).toBe(0);
  });

  it("refuses a ticket count outside the order", () => {
    expect(() => paidShare(order(100, 2), 3)).toThrow(new RangeError("cancelled tickets out of range"));
    expect(() => paidShare(order(100, 2), -1)).toThrow(RangeError);
  });
});

describe("eventCancellationRefund", () => {
  it("an untouched order gets its whole tickets part, no fee", () => {
    expect(eventCancellationRefund(order(10_000, 2), NOTHING_REFUNDED)).toEqual({ tickets: 2, grossCents: 10_000, feeCents: 0, netCents: 10_000 });
  });

  it("after a partial cancel: the tickets still held, no fee; the earlier fee stays kept", () => {
    const o = order(10_000, 4);
    const { quotes, soFar } = cancelInParts(o, [1]);
    expect(quotes[0]).toMatchObject({ grossCents: 2_500, feeCents: 50, netCents: 2_450 });
    const r = eventCancellationRefund(o, soFar);
    expect(r).toEqual({ tickets: 3, grossCents: 7_500, feeCents: 0, netCents: 7_500 });
    // Gross over the order is exactly the tickets part; the customer is out only the partial cancel's fee.
    expect(soFar.grossCents + r.grossCents).toBe(10_000);
    expect(quotes[0].netCents + r.netCents).toBe(10_000 - 50);
  });

  it("pays the tickets still held, not the cents a late cancel left unrefunded", () => {
    // 1 ticket cancelled after the start (refunded 0): the customer no longer holds it.
    const o = order(10_000, 4);
    expect(eventCancellationRefund(o, { ticketsCancelled: 1, grossCents: 0, feeCents: 0 })).toMatchObject({ tickets: 3, grossCents: 7_500 });
  });

  it("never takes the order's gross above what was paid, even on a history it did not write", () => {
    const o = order(10_000, 4);
    expect(eventCancellationRefund(o, { ticketsCancelled: 1, grossCents: 9_000, feeCents: 0 })).toMatchObject({ grossCents: 1_000, netCents: 1_000 });
    expect(eventCancellationRefund(o, { ticketsCancelled: 1, grossCents: 12_000, feeCents: 0 })).toMatchObject({ grossCents: 0, netCents: 0 });
  });

  it("refuses a history that cannot belong to the order", () => {
    expect(() => eventCancellationRefund(order(100, 2), { ticketsCancelled: 3, grossCents: 0, feeCents: 0 })).toThrow(RangeError);
    expect(() => eventCancellationRefund(order(100, 2), { ticketsCancelled: 1, grossCents: -5, feeCents: 0 })).toThrow(RangeError);
  });
});

// ---- Properties -------------------------------------------------------------

/** An order and a split of all its tickets into cancels: positive parts that add up to the ticket count. */
const orderAndParts = fc
  .record({ total: fc.integer({ min: 0, max: 50_000_000 }), tickets: fc.integer({ min: 1, max: 60 }), cuts: fc.array(fc.nat(), { maxLength: 8 }) })
  .map(({ total, tickets, cuts }) => {
    const points = [...new Set(cuts.map((c) => (c % tickets) + 1).filter((c) => c < tickets))].sort((a, b) => a - b);
    const parts = [...points, tickets].map((p, i, all) => p - (i === 0 ? 0 : all[i - 1]));
    return { o: order(total, tickets), parts };
  });

describe("properties", () => {
  it("every single cancel: fee + net = gross, nothing negative, seats released", () => {
    fc.assert(
      fc.property(orderAndParts, ({ o, parts }) => {
        for (const q of cancelInParts(o, parts).quotes) {
          expect(q.feeCents + q.netCents).toBe(q.grossCents);
          expect(q.netCents).toBeGreaterThanOrEqual(0);
          expect(q.feeCents).toBeGreaterThanOrEqual(0);
          expect(q.releasesSeats).toBe(true);
        }
      }),
      { numRuns: 1_000 },
    );
  });

  it("after any partial cancels, an event cancellation brings the order's gross to exactly what was paid, with no new fee", () => {
    fc.assert(
      fc.property(orderAndParts, fc.nat(), ({ o, parts }, k) => {
        // Cancel only the first few parts, so some tickets are still held.
        const taken = parts.slice(0, k % parts.length);
        const { quotes, soFar } = cancelInParts(o, taken);
        const r = eventCancellationRefund(o, soFar);
        expect(r.tickets).toBe(o.tickets - soFar.ticketsCancelled);
        expect(r.feeCents).toBe(0);
        expect(r.netCents).toBe(r.grossCents);
        expect(soFar.grossCents + r.grossCents).toBe(o.totalCents);
        expect(sum(quotes.map((q) => q.netCents)) + r.netCents).toBe(o.totalCents - soFar.feeCents);
      }),
      { numRuns: 1_000 },
    );
  });

  it("outside the window, whatever came before: cancelling every ticket left is zero and keeps the seats, anything less is refused", () => {
    fc.assert(
      fc.property(orderAndParts, fc.nat(), fc.integer({ min: 0, max: 10_000_000 }), ({ o, parts }, k, late) => {
        // The first few parts were cancelled in time; the customer comes back after the start.
        const { soFar } = cancelInParts(o, parts.slice(0, k % parts.length));
        const left = o.tickets - soFar.ticketsCancelled;
        expect(quoteCancellation(o, soFar, left, START + late)).toEqual({ tickets: left, windowOpen: false, grossCents: 0, feeCents: 0, netCents: 0, releasesSeats: false });
        for (let n = 1; n < left; n++) expect(() => quoteCancellation(o, soFar, n, START + late)).toThrow(new RangeError(PARTIAL_CANCEL_CLOSED));
      }),
      { numRuns: 500 },
    );
  });
});
