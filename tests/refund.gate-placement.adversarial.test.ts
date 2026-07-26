// Adversarial lane, round 2: attacking the fix rather than the hole it filled.
//
// src/refund.ts:55 now reads `if (nowMs >= order.eventStartMs) return 0;`, sitting
// below every validator. Two things can go wrong with a gate placed like that and
// neither is visible from the round-1 boundary tests:
//
//   1. If it drifts ABOVE the validators, a malformed order cancelled after the
//      event stops raising and starts returning a plausible-looking zero. The
//      caller never learns its request was bad — it just sees "no refund owed",
//      which is indistinguishable from a legitimately closed window.
//   2. If the gate changed anything on the open side, every refund before the
//      event is now wrong, and the round-1 tests only sample a handful of clocks.
//
// This file pins both: the exact error that must still surface for each invalid
// field at four clock positions, and the whole input/output contract against an
// independent BigInt oracle over 20,000 randomised cases.
import { describe, it, expect } from "vitest";
import { calculateRefund, netRefund, Order } from "../src/refund";

const START = 1_800_000_000_000;
const DAY = 86_400_000;

const order = (over: Partial<Order> = {}): Order => ({
  totalCents: 10_000,
  tickets: 4,
  discountPercent: 0,
  eventStartMs: START,
  ...over,
});

const f64 = new Float64Array(1);
const i64 = new BigInt64Array(f64.buffer);

function nextDouble(v: number): number {
  if (v === 0) return Number.MIN_VALUE;
  f64[0] = v;
  i64[0] += v > 0 ? 1n : -1n;
  return f64[0];
}

function previousDouble(v: number): number {
  if (v === 0) return -Number.MIN_VALUE;
  f64[0] = v;
  i64[0] += v > 0 ? -1n : 1n;
  return f64[0];
}

/** Every clock position that matters, on both sides of the closing instant. */
const CLOCKS: [string, number][] = [
  ["a day before the event", START - DAY],
  ["one ULP before the event", previousDouble(START)],
  ["exactly at the event start", START],
  ["one ULP after the event", nextDouble(START)],
  ["a day after the event", START + DAY],
];

/** Orders that must be refused, with the message the caller is entitled to. */
const MALFORMED: [string, Order, number, string][] = [
  ["a fractional cancellation", order(), 1.5, "cancelled tickets out of range"],
  ["a negative cancellation", order(), -1, "cancelled tickets out of range"],
  ["cancelling more than the order holds", order(), 5, "cancelled tickets out of range"],
  ["a NaN cancellation", order(), Number.NaN, "cancelled tickets out of range"],
  ["an order with no tickets", order({ tickets: 0 }), 0, "order must have at least one ticket"],
  ["an order with fractional tickets", order({ tickets: 2.5 }), 2, "order must have at least one ticket"],
  ["a discount above 100", order({ discountPercent: 150 }), 4, "discount out of range"],
  ["a NaN discount", order({ discountPercent: Number.NaN }), 4, "discount out of range"],
  ["a negative total", order({ totalCents: -1 }), 4, "order total out of range"],
  ["a fractional total", order({ totalCents: 10.5 }), 4, "order total out of range"],
  ["a total past MAX_SAFE_INTEGER", order({ totalCents: 2 ** 53 }), 4, "order total out of range"],
];

describe("the gate sits below the validators — a bad order is still refused after the show", () => {
  // The point of the whole block: `return 0` must never become the answer to a
  // question that was malformed. Silence about a broken request is how a caller
  // ships a bug that only shows up in a reconciliation report months later.
  it.each(MALFORMED)("refuses %s, at every clock position", (_label, o, cancelled, message) => {
    for (const [, now] of CLOCKS) {
      let thrown: unknown;
      try {
        calculateRefund(o, cancelled, now);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RangeError);
      expect((thrown as RangeError).message).toBe(message);
    }
  });

  it.each(MALFORMED)("refuses %s through netRefund too, at every clock position", (_label, o, cancelled, message) => {
    for (const [, now] of CLOCKS) {
      expect(() => netRefund(o, cancelled, now)).toThrow(message);
    }
  });

  // An unusable clock must not be read as "the window is closed". A gate above
  // the clock validator would answer 0 for `nowMs = NaN` (NaN >= x is false, so
  // it would fall through) or for `Infinity` (which would close every window).
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["undefined", undefined],
    ["null", null],
    ["a numeric string", "1800000000001"],
  ])("still refuses an unusable clock rather than gating on it: %s", (_label, now) => {
    expect(() => calculateRefund(order(), 4, now as number)).toThrow("current time out of range");
    expect(() => netRefund(order(), 4, now as number)).toThrow("current time out of range");
  });

  // An unusable event start is refused before the comparison that would use it.
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("still refuses an unusable event start: %s", (_label, eventStartMs) => {
    expect(() => calculateRefund(order({ eventStartMs }), 4, START)).toThrow("event start out of range");
  });

  // Pinned in round 1 as cosmetic, re-pinned here because the fix moved code in
  // this function: a negative ticket count reports the cancellation message
  // first, because the range comparison runs before the ticket check. Unchanged
  // by the gate, and unchanged on either side of the event.
  it("reports the same error first for a negative ticket count as it did before the gate", () => {
    for (const [, now] of CLOCKS) {
      expect(() => calculateRefund(order({ tickets: -5 }), 0, now)).toThrow("cancelled tickets out of range");
    }
  });
});

// ---------------------------------------------------------------------------
// The whole contract, against an oracle that shares no code with src/refund.ts.
// ---------------------------------------------------------------------------

/** `total * part / whole`, rounded half up, in exact integer arithmetic. */
function exactHalfUp(total: bigint, part: bigint, whole: bigint): bigint {
  const q = (total * part) / whole;
  const r = (total * part) % whole;
  return r * 2n >= whole ? q + 1n : q;
}

describe("the gate composes with the arithmetic instead of disturbing it", () => {
  // 20,000 randomised orders and clocks, drawn deliberately close to the closing
  // instant so roughly half of them land on each side of it. For each: closed
  // window pays exactly zero, open window pays exactly the half-up share.
  it("answers zero on every closed clock and the exact share on every open one", () => {
    let closed = 0;
    let open = 0;

    for (let i = 0; i < 20_000; i++) {
      const tickets = 1 + Math.floor(Math.random() * 64);
      const cancelled = Math.floor(Math.random() * (tickets + 1));
      const totalCents = Math.floor(Math.random() * (i % 3 === 0 ? Number.MAX_SAFE_INTEGER : 100_000));
      const eventStartMs = Math.floor((Math.random() - 0.5) * 4e12);
      const o: Order = { totalCents, tickets, discountPercent: 0, eventStartMs };

      // Clocks clustered on the boundary: exactly on it, one ULP either side,
      // and a spread of whole milliseconds around it.
      const offset = Math.floor((Math.random() - 0.5) * 2_000);
      const now = [eventStartMs, nextDouble(eventStartMs), previousDouble(eventStartMs), eventStartMs + offset][
        i % 4
      ];

      const got = calculateRefund(o, cancelled, now);

      if (now >= eventStartMs) {
        expect(got).toBe(0);
        closed++;
      } else {
        expect(BigInt(got)).toBe(exactHalfUp(BigInt(totalCents), BigInt(cancelled), BigInt(tickets)));
        open++;
      }
    }

    // The run is worthless if it only ever saw one side of the gate.
    expect(closed).toBeGreaterThan(2_000);
    expect(open).toBeGreaterThan(2_000);
  });

  // The same sweep for the money the customer actually receives: fee first, then
  // the floor at zero, and never a cent more than the gross refund.
  it("nets out to zero on a closed clock and to gross-less-fee on an open one", () => {
    for (let i = 0; i < 20_000; i++) {
      const tickets = 1 + Math.floor(Math.random() * 32);
      const cancelled = Math.floor(Math.random() * (tickets + 1));
      const totalCents = Math.floor(Math.random() * 1_000_000);
      const eventStartMs = Math.floor((Math.random() - 0.5) * 4e12);
      const o: Order = { totalCents, tickets, discountPercent: 0, eventStartMs };
      const now = i % 2 ? eventStartMs + Math.floor(Math.random() * 1_000) : eventStartMs - 1 - Math.floor(Math.random() * 1_000);

      const gross = calculateRefund(o, cancelled, now);
      const net = netRefund(o, cancelled, now);

      if (now >= eventStartMs) {
        expect(gross).toBe(0);
        expect(net).toBe(0);
      } else {
        const fee = gross <= 0 ? 0 : Math.min(gross, Math.max(50, Math.round(gross * 0.02)));
        expect(net).toBe(Math.max(0, gross - fee));
      }
    }
  });
});
