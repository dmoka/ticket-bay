import { describe, it, expect } from "vitest";
import { eventStatus } from "../../lib/status";
import type { EventRow } from "../../src/db/schema";

// Reported via customer email: homepage showed "Few left" on an event that
// was actually fully sold out (totalSeats === seatsSold), so the customer
// could not book anything they were told was nearly available.
function makeEvent(overrides: Partial<EventRow>): EventRow {
  return {
    id: "ev-1",
    name: "Nova Kings — Arena Show",
    category: "concert",
    venue: "Arena",
    city: "City",
    description: "",
    startsAtMs: Date.now() + 1000 * 60 * 60 * 24,
    totalSeats: 100,
    seatsSold: 0,
    priceCents: 5000,
    createdAtMs: Date.now(),
    cancelledAtMs: null,
    ...overrides,
  };
}

describe("eventStatus", () => {
  it("reports sold-out, not few-left, when every seat is sold", () => {
    const ev = makeEvent({ totalSeats: 100, seatsSold: 100 });
    expect(eventStatus(ev, Date.now())).toBe("sold-out");
  });
});
