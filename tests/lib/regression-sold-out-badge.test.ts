import { describe, it, expect } from "vitest";
import type { EventRow } from "@/src/db/schema";
import { eventStatus, STATUS_LABEL } from "@/lib/status";

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function event(overrides: Partial<EventRow>): EventRow {
  return {
    id: "midnight-arcade",
    name: "Midnight Arcade",
    category: "concert",
    venue: "Venue",
    city: "Budapest",
    description: "",
    startsAtMs: NOW + 10 * DAY,
    totalSeats: 200,
    seatsSold: 0,
    priceCents: 4_500,
    createdAtMs: NOW - 30 * DAY,
    cancelledAtMs: null,
    ...overrides,
  };
}

describe("regression: a sold-out event shows 'Sold out', not 'Few left'", () => {
  it("every seat sold → sold-out", () => {
    const status = eventStatus(event({ totalSeats: 200, seatsSold: 200 }), NOW);
    expect(status).toBe("sold-out");
    expect(STATUS_LABEL[status]).toBe("Sold out");
  });

  it("one seat left is still few-left", () => {
    expect(eventStatus(event({ totalSeats: 200, seatsSold: 199 }), NOW)).toBe("few-left");
  });
});
