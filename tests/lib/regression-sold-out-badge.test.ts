import { describe, expect, it } from "vitest";
import type { EventRow } from "@/src/db/schema";
import { eventStatus, STATUS_LABEL } from "@/lib/status";

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 5, 12);

function event(totalSeats: number, seatsSold: number): EventRow {
  return {
    id: "ev-1",
    name: "Sold-out concert",
    category: "concert",
    venue: "Arena",
    city: "Budapest",
    description: "",
    startsAtMs: now + 3 * DAY,
    totalSeats,
    seatsSold,
    priceCents: 4500,
    createdAtMs: now - 30 * DAY,
    cancelledAtMs: null,
  };
}

describe("regression: a sold-out event shows the Sold out badge", () => {
  it("every seat sold -> sold-out, not few-left", () => {
    const status = eventStatus(event(100, 100), now);
    expect(status).toBe("sold-out");
    expect(STATUS_LABEL[status]).toBe("Sold out");
  });

  it("one seat left is still few-left", () => {
    expect(eventStatus(event(100, 99), now)).toBe("few-left");
  });
});
