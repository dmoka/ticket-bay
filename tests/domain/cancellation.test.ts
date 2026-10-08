// What cancelling a whole order pays and does to the seats (src/domain/cancellation.ts).
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { AGENT_REFUND_LIMIT_CENTS, agentMayRefund, previewCancellation } from "../../src/domain/cancellation";
import { netRefund } from "../../src/domain/refund";

const START = 1_800_000_000_000;
const order = (totalCents: number, tickets = 2) => ({ totalCents, tickets, discountPercent: 0, eventStartMs: START });

describe("previewCancellation", () => {
  it("pays the paid amount less the 2% fee before the event", () => {
    expect(previewCancellation(order(10_000), START - 1)).toEqual({
      windowOpen: true,
      grossCents: 10_000,
      feeCents: 200,
      netCents: 9_800,
      releasesSeats: true,
    });
  });

  it("pays nothing and keeps the seats taken from the instant the event starts", () => {
    expect(previewCancellation(order(10_000), START)).toEqual({
      windowOpen: false,
      grossCents: 0,
      feeCents: 0,
      netCents: 0,
      releasesSeats: false,
    });
  });

  it("still releases the seats when the minimum fee swallows the whole refund", () => {
    const p = previewCancellation(order(25, 1), START - 1);
    expect(p.netCents).toBe(0);
    expect(p.feeCents).toBe(25);
    expect(p.releasesSeats).toBe(true);
  });

  it("always agrees with netRefund, and fee + net always equals gross", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: -3, max: 3 }),
        (total, tickets, offset) => {
          const o = order(total, tickets);
          const p = previewCancellation(o, START + offset);
          expect(p.netCents).toBe(netRefund(o, tickets, START + offset));
          expect(p.feeCents + p.netCents).toBe(p.grossCents);
          expect(p.releasesSeats).toBe(START + offset < START);
        },
      ),
    );
  });
});

describe("agentMayRefund", () => {
  it("the limit is exactly €100.00", () => {
    expect(AGENT_REFUND_LIMIT_CENTS).toBe(10_000);
  });

  it("allows up to and including the limit, refuses one cent above", () => {
    expect(agentMayRefund(0)).toBe(true);
    expect(agentMayRefund(9_999)).toBe(true);
    expect(agentMayRefund(10_000)).toBe(true);
    expect(agentMayRefund(10_001)).toBe(false);
    expect(agentMayRefund(1_000_000)).toBe(false);
  });

  it("an order whose cancellation pays over the limit is one the agent must hand back", () => {
    // €102.05 paid → 2% fee €2.04 → €100.01 net: one cent too much.
    const over = previewCancellation(order(10_205, 1), START - 1);
    expect(over.netCents).toBe(10_001);
    expect(agentMayRefund(over.netCents)).toBe(false);
    // €102.04 paid → fee €2.04 → €100.00 net: the agent may.
    const edge = previewCancellation(order(10_204, 1), START - 1);
    expect(edge.netCents).toBe(10_000);
    expect(agentMayRefund(edge.netCents)).toBe(true);
  });
});
