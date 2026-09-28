import { describe, it, expect } from "vitest";
import type { EventRow } from "@/src/db/schema";
import { eventStatus } from "@/lib/status";

function baseEvent(overrides: Partial<EventRow>): EventRow {
  return {
    id: "ev1",
    name: "Nova Kings — Arena Show",
    category: "concert",
    venue: "Arena",
    city: "City",
    description: "",
    startsAtMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
    totalSeats: 100,
    seatsSold: 0,
    priceCents: 1000,
    createdAtMs: Date.now(),
    cancelledAtMs: null,
    ...overrides,
  } as EventRow;
}

describe("eventStatus", () => {
  it("reports sold-out, not few-left, once every seat is sold", () => {
    const ev = baseEvent({ totalSeats: 100, seatsSold: 100 });
    expect(eventStatus(ev, Date.now())).toBe("sold-out");
  });

  it("still reports few-left when seats remain below the threshold", () => {
    const ev = baseEvent({ totalSeats: 100, seatsSold: 95 });
    expect(eventStatus(ev, Date.now())).toBe("few-left");
  });
});
