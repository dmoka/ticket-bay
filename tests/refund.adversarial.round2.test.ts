// Adversarial lane, round 2 — attacks aimed at the FIX, not at the original bug.
// Round 1's failures are pinned in refund.adversarial.test.ts and now pass;
// this file exists so the specific ways the fix could have been written wrong
// stay pinned.
import { describe, it, expect } from "vitest";
import { calculateRefund, netRefund } from "../src/refund";

const S = 1_700_000_000_000;
const ord = (o = {}) => ({ totalCents: 10_000, tickets: 4, discountPercent: 0, eventStartMs: S, ...o });

// Exact rational, rounded half up. No floating point anywhere.
const exact = (total: bigint, part: bigint, whole: bigint) => {
  const q = (total * part) / whole;
  const r = (total * part) % whole;
  return r * 2n >= whole ? q + 1n : q;
};

describe("the gate boundary, one tick either side", () => {
  it("pays in full at the last representable instant before the start", () => {
    expect(calculateRefund(ord(), 4, S - 1)).toBe(10_000);
  });

  it("pays nothing at the start instant itself", () => {
    expect(calculateRefund(ord(), 4, S)).toBe(0);
  });

  it("pays nothing one tick after", () => {
    expect(calculateRefund(ord(), 4, S + 1)).toBe(0);
  });

  it("compares the clock to the event, not to a hardcoded epoch", () => {
    // A gate written against `Date.now()` or a constant instead of the order's
    // own start would get one of these two backwards.
    expect(calculateRefund(ord({ eventStartMs: 0 }), 4, -1)).toBe(10_000);
    expect(calculateRefund(ord({ eventStartMs: 0 }), 4, 0)).toBe(0);
  });

  it("handles a negative epoch event start", () => {
    expect(calculateRefund(ord({ eventStartMs: -1_000 }), 4, -1_001)).toBe(10_000);
    expect(calculateRefund(ord({ eventStartMs: -1_000 }), 4, -1_000)).toBe(0);
  });

  it("gates on a sub-millisecond event start without rounding the customer over the line", () => {
    expect(calculateRefund(ord({ eventStartMs: S + 0.5 }), 4, S)).toBe(10_000);
    expect(calculateRefund(ord({ eventStartMs: S - 0.5 }), 4, S)).toBe(0);
  });

  it("treats -0 as the same instant as 0", () => {
    expect(calculateRefund(ord({ eventStartMs: 0 }), 4, -0)).toBe(0);
  });
});

describe("the clock is validated, and validation runs before the gate", () => {
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["undefined", undefined],
    ["null", null],
    ["a numeric string", "1700000000001"],
  ])("refuses an unusable clock: %s", (_label, now) => {
    expect(() => calculateRefund(ord(), 4, now as number)).toThrow(RangeError);
  });

  it.each([
    ["more tickets than the order holds", ord(), 5],
    ["a negative cancellation", ord(), -1],
    ["a fractional cancellation", ord(), 1.5],
    ["an order with no tickets", ord({ tickets: 0 }), 0],
    ["a negative total", ord({ totalCents: -1 }), 4],
    ["a fractional total", ord({ totalCents: 100.5 }), 4],
    ["an impossible discount", ord({ discountPercent: 150 }), 4],
    ["a non-finite event start", ord({ eventStartMs: Number.NaN }), 4],
  ])("still rejects %s after the event has started, instead of masking it as a zero refund", (_l, o, c) => {
    // If the gate were placed above the validators, every one of these would
    // come back as a plausible-looking 0 and the bad order would never surface.
    expect(() => calculateRefund(o as never, c as number, S + 3_600_000)).toThrow(RangeError);
  });
});

describe("exactShare — the new arithmetic on the money path", () => {
  const share = (total: number, part: number, whole: number) =>
    calculateRefund({ totalCents: total, tickets: whole, discountPercent: 0, eventStartMs: 1 }, part, 0);

  it("agrees with an exact rational half-up reference across the whole admitted range", () => {
    let checked = 0;
    for (let i = 0; i < 20_000; i++) {
      const whole = 1 + Math.floor(Math.random() * 64);
      const part = Math.floor(Math.random() * (whole + 1));
      const total = Math.floor(Math.random() * (i % 2 ? 10_000 : Number.MAX_SAFE_INTEGER));
      expect(BigInt(share(total, part, whole))).toBe(exact(BigInt(total), BigInt(part), BigInt(whole)));
      checked++;
    }
    expect(checked).toBe(20_000);
  });

  it("never returns more than was actually paid", () => {
    for (let i = 0; i < 20_000; i++) {
      const whole = 1 + Math.floor(Math.random() * 64);
      const part = Math.floor(Math.random() * (whole + 1));
      const total = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      const got = share(total, part, whole);
      expect(got).toBeLessThanOrEqual(total);
      expect(got).toBeGreaterThanOrEqual(0);
      expect(Number.isSafeInteger(got)).toBe(true);
    }
  });

  it("rounds a half-cent share up, as 'nearest cent' requires", () => {
    expect(share(1, 1, 2)).toBe(1); // 0.5 -> 1
    expect(share(101, 1, 2)).toBe(51); // 50.5 -> 51
    expect(share(100, 1, 8)).toBe(13); // 12.5 -> 13
    expect(share(100, 3, 8)).toBe(38); // 37.5 -> 38
  });

  it("rounds a below-half share down", () => {
    expect(share(1, 1, 3)).toBe(0); // 0.333 -> 0
    expect(share(10_000, 1, 3)).toBe(3_333);
    expect(share(10_000, 2, 3)).toBe(6_667);
  });

  it("keeps the parts of a three-way split adding up to the whole", () => {
    expect(share(10_000, 1, 3) + share(10_000, 2, 3)).toBe(10_000);
  });

  it("survives the top of the admitted range without drifting a cent", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(share(max, 3, 3)).toBe(max);
    expect(share(max, 1, 3)).toBe(3_002_399_751_580_330);
    expect(share(max, 2, 3)).toBe(6_004_799_503_160_661);
    expect(share(max, 1, 3) + share(max, 2, 3)).toBe(max);
  });

  it("beats the old float arithmetic on the case that motivated it", () => {
    // Math.round((957886741657959 * 9) / 11) answers 783725515901967 — one cent
    // more than was paid a share of. The exact answer is ...966.
    expect(share(957_886_741_657_959, 9, 11)).toBe(783_725_515_901_966);
    expect(share(7_522_654_048_945_927, 1, 3)).toBe(2_507_551_349_648_642);
  });

  it("does not throw on the degenerate inputs the validators admit", () => {
    expect(share(0, 0, 1)).toBe(0);
    expect(share(0, 4, 4)).toBe(0);
    expect(share(10_000, 0, 4)).toBe(0);
    expect(calculateRefund(ord({ totalCents: -0 }), 4, 0)).toBe(10_000 * 0);
    expect(calculateRefund(ord(), -0, 0)).toBe(0);
  });

  it("does not throw on the absurd-but-admitted ticket counts", () => {
    // `tickets` has no MAX_SAFE_INTEGER bound the way `totalCents` does.
    expect(share(10_000, 1, 1e21)).toBe(0);
    expect(share(10_000, 1, 1e300)).toBe(0);
    expect(share(10_000, 1e300, 1e300)).toBe(10_000);
  });
});

describe("netRefund inherits the gate and the exact arithmetic", () => {
  it("returns nothing at and after the start", () => {
    expect(netRefund(ord(), 4, S)).toBe(0);
    expect(netRefund(ord(), 4, S + 1)).toBe(0);
  });

  it("still pays before the start", () => {
    expect(netRefund(ord(), 4, S - 1)).toBe(9_800);
  });

  it("refuses an unusable clock rather than paying out", () => {
    expect(() => netRefund(ord(), 4, Number.NaN)).toThrow(RangeError);
  });

  it("never pays more than the gross refund, and never less than zero", () => {
    for (let i = 0; i < 10_000; i++) {
      const whole = 1 + Math.floor(Math.random() * 32);
      const part = Math.floor(Math.random() * (whole + 1));
      const total = Math.floor(Math.random() * 1_000_000);
      const o = { totalCents: total, tickets: whole, discountPercent: 0, eventStartMs: S };
      const gross = calculateRefund(o, part, S - 1);
      const net = netRefund(o, part, S - 1);
      expect(net).toBeGreaterThanOrEqual(0);
      expect(net).toBeLessThanOrEqual(gross);
      expect(Number.isInteger(net)).toBe(true);
    }
  });
});
