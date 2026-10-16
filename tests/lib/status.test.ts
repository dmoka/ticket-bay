import { describe, it, expect } from "vitest";
import type { EventRow } from "../../src/db/schema";
import { eventStatus, FEW_LEFT_SEATS } from "../../lib/status";

const NOW = Date.UTC(2026, 9, 6, 12, 0);
const DAY = 86_400_000;

function event(totalSeats: number, seatsSold: number): EventRow {
  return { totalSeats, seatsSold, startsAtMs: NOW + 10 * DAY, cancelledAtMs: null } as unknown as EventRow;
}

describe("eventStatus few-left", () => {
  it("shows few-left from FEW_LEFT_SEATS seats down, in a big venue", () => {
    expect(eventStatus(event(5_000, 5_000 - FEW_LEFT_SEATS), NOW)).toBe("few-left");
    expect(eventStatus(event(5_000, 5_000 - FEW_LEFT_SEATS - 1), NOW)).toBe("on-sale");
  });

  it("no longer shows few-left with hundreds of seats left", () => {
    // 10% of 5,000 is 500 seats: the old rule called that "few left".
    expect(eventStatus(event(5_000, 4_600), NOW)).toBe("on-sale");
  });

  it("still shows sold-out at zero seats", () => {
    expect(eventStatus(event(300, 300), NOW)).toBe("sold-out");
  });
});
