import { describe, it, expect } from "vitest";
import { eventStatus } from "@/lib/status";
import type { EventRow } from "@/src/db/schema";

// Reported: a show with no seats left showed the "Few left" badge instead of "Sold out".
const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 6);

function event(totalSeats: number, seatsSold: number): EventRow {
  return {
    totalSeats,
    seatsSold,
    startsAtMs: now + 2 * DAY,
    cancelledAtMs: null,
  } as unknown as EventRow;
}

describe("eventStatus when every seat is sold", () => {
  it("says sold-out, not few-left", () => {
    expect(eventStatus(event(500, 500), now)).toBe("sold-out");
  });

  it("still says few-left with one seat remaining", () => {
    expect(eventStatus(event(500, 499), now)).toBe("few-left");
  });
});
