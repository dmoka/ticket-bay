import { describe, expect, it } from "vitest";
import { eventStatus } from "@/lib/status";
import type { EventRow } from "@/src/db/schema";

const NOW = Date.UTC(2026, 9, 7);

function soldOutEvent(): EventRow {
  return {
    id: "nova-kings-arena",
    name: "Nova Kings — Arena Show",
    category: "concert",
    venue: "MVM Dome",
    city: "Budapest",
    description: "",
    startsAtMs: NOW + 18 * 24 * 60 * 60 * 1000,
    totalSeats: 120,
    seatsSold: 120,
    priceCents: 7900,
    createdAtMs: NOW,
    cancelledAtMs: null,
  };
}

describe("sold-out event badge", () => {
  it("reports sold out when no seats remain", () => {
    expect(eventStatus(soldOutEvent(), NOW)).toBe("sold-out");
  });
});
