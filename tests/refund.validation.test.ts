// Adversarial lane, round 3 — the killing tests for the three mutants the
// mutation lane flagged as reachable. The other six survivors it reported are
// mathematically equivalent and deliberately not chased here.
import { describe, it, expect } from "vitest";
import { calculateRefund, netRefund } from "../src/refund";

const S = 1_700_000_000_000;
const BEFORE = S - 1;
const ord = (o = {}) => ({ totalCents: 10_000, tickets: 4, discountPercent: 0, eventStartMs: S, ...o });

/** The message of the RangeError a call throws, or a failure if it does not throw. */
const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RangeError);
    return (e as RangeError).message;
  }
  throw new Error("expected the call to throw, but it returned");
};

describe("the safe-integer ceiling on totalCents", () => {
  // Deleting `order.totalCents > Number.MAX_SAFE_INTEGER` turns a refusal into a
  // payout: the order is accepted and refunded roughly ninety trillion euros.
  it("refuses a total one above the safe-integer limit", () => {
    expect(() => calculateRefund(ord({ totalCents: 2 ** 53 }), 4, BEFORE)).toThrow(RangeError);
  });

  it("refuses the next representable total above that", () => {
    // 2**53 + 1 is not representable as a double; 2**53 + 2 is.
    expect(() => calculateRefund(ord({ totalCents: 2 ** 53 + 2 }), 4, BEFORE)).toThrow(RangeError);
  });

  it("refuses an absurdly large but integral total", () => {
    expect(() => calculateRefund(ord({ totalCents: 1e300 }), 4, BEFORE)).toThrow(RangeError);
  });

  it("still accepts a total exactly at the limit", () => {
    // Guards the boundary from the other side: tightening `>` to `>=` would
    // start rejecting a total the function is documented to admit.
    expect(calculateRefund(ord({ totalCents: Number.MAX_SAFE_INTEGER }), 4, BEFORE)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("never pays out on an over-limit total through netRefund either", () => {
    expect(() => netRefund(ord({ totalCents: 2 ** 53 }), 4, BEFORE)).toThrow(RangeError);
  });
});

describe("the discount range check", () => {
  it("refuses a negative discount", () => {
    expect(() => calculateRefund(ord({ discountPercent: -1 }), 4, BEFORE)).toThrow(RangeError);
  });

  it("refuses a discount a hair below zero", () => {
    expect(() => calculateRefund(ord({ discountPercent: -0.0001 }), 4, BEFORE)).toThrow(RangeError);
  });

  it("refuses a discount a hair above a hundred", () => {
    expect(() => calculateRefund(ord({ discountPercent: 100.0001 }), 4, BEFORE)).toThrow(RangeError);
  });

  it("refuses a discount that is not a number at all", () => {
    expect(() => calculateRefund(ord({ discountPercent: Number.NaN }), 4, BEFORE)).toThrow(RangeError);
  });

  it("accepts both ends of the documented range", () => {
    // Kills `>= 0` -> `> 0` and `<= 100` -> `< 100`: both endpoints are legal.
    expect(calculateRefund(ord({ discountPercent: 0 }), 4, BEFORE)).toBe(10_000);
    expect(calculateRefund(ord({ discountPercent: 100 }), 4, BEFORE)).toBe(10_000);
  });
});

describe("the RangeError messages are the diagnosis, so pin them exactly", () => {
  it("names the cancellation count", () => {
    expect(messageOf(() => calculateRefund(ord(), 5, BEFORE))).toBe("cancelled tickets out of range");
  });

  it("names the empty order", () => {
    expect(messageOf(() => calculateRefund(ord({ tickets: 0 }), 0, BEFORE))).toBe(
      "order must have at least one ticket",
    );
  });

  it("names the discount", () => {
    expect(messageOf(() => calculateRefund(ord({ discountPercent: -1 }), 4, BEFORE))).toBe(
      "discount out of range",
    );
  });

  it("names the order total", () => {
    expect(messageOf(() => calculateRefund(ord({ totalCents: 2 ** 53 }), 4, BEFORE))).toBe(
      "order total out of range",
    );
  });

  it("names the event start", () => {
    expect(messageOf(() => calculateRefund(ord({ eventStartMs: Number.NaN }), 4, BEFORE))).toBe(
      "event start out of range",
    );
  });

  it("names the clock — the one message a broken-clock incident is read from", () => {
    // Blank this string and a production payout outage reports an empty
    // RangeError with nothing to say which of six inputs was wrong.
    expect(messageOf(() => calculateRefund(ord(), 4, Number.NaN))).toBe("current time out of range");
  });

  it("carries the same messages up through netRefund", () => {
    expect(messageOf(() => netRefund(ord(), 4, Number.NaN))).toBe("current time out of range");
    expect(messageOf(() => netRefund(ord({ discountPercent: -1 }), 4, BEFORE))).toBe(
      "discount out of range",
    );
  });

  it("gives six distinct messages, one per input", () => {
    const messages = [
      messageOf(() => calculateRefund(ord(), 5, BEFORE)),
      messageOf(() => calculateRefund(ord({ tickets: 0 }), 0, BEFORE)),
      messageOf(() => calculateRefund(ord({ discountPercent: -1 }), 4, BEFORE)),
      messageOf(() => calculateRefund(ord({ totalCents: 2 ** 53 }), 4, BEFORE)),
      messageOf(() => calculateRefund(ord({ eventStartMs: Number.NaN }), 4, BEFORE)),
      messageOf(() => calculateRefund(ord(), 4, Number.NaN)),
    ];
    expect(new Set(messages).size).toBe(6);
    expect(messages.every((m) => m.length > 0)).toBe(true);
  });
});
