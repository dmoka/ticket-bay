import { describe, it, expect } from "vitest";
import { eventStatus, STATUS_LABEL } from "@/lib/status";
import type { EventRow } from "@/src/db/schema";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 5, 12);

function event(over: Partial<EventRow>): EventRow {
  return {
    id: "velvet-static",
    name: "The Velvet Static — Live",
    category: "concert",
    venue: "Hall",
    city: "Budapest",
    description: "",
    startsAtMs: NOW + 7 * DAY,
    totalSeats: 200,
    seatsSold: 0,
    priceCents: 4_500,
    createdAtMs: NOW - 30 * DAY,
    cancelledAtMs: null,
    ...over,
  };
}

describe("regression: a sold-out event shows the Sold out badge, not Few left", () => {
  it("every seat sold → sold-out", () => {
    const status = eventStatus(event({ totalSeats: 200, seatsSold: 200 }), NOW);
    expect(status).toBe("sold-out");
    expect(STATUS_LABEL[status]).toBe("Sold out");
  });

  it("one seat left is still few-left", () => {
    expect(eventStatus(event({ totalSeats: 200, seatsSold: 199 }), NOW)).toBe("few-left");
  });
});
