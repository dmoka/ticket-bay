import { describe, it, expect } from "vitest";
import { eventStatus } from "../../lib/status";
import type { EventRow } from "@/src/db/schema";

function makeEvent(overrides: Partial<EventRow>): EventRow {
  return {
    id: "evt-1",
    name: "Nova Kings — Arena Show",
    category: "concert",
    venue: "Arena",
    city: "Berlin",
    description: "",
    startsAtMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
    totalSeats: 100,
    seatsSold: 100,
    priceCents: 5_000,
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

  it("still reports few-left when seats remain below the 10% threshold", () => {
    const ev = makeEvent({ totalSeats: 100, seatsSold: 95 });
    expect(eventStatus(ev, Date.now())).toBe("few-left");
  });
});
