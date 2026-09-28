import { describe, expect, it } from "vitest";
import { eventStatus } from "@/lib/status";
import type { EventRow } from "@/src/db/schema";

const NOW = Date.UTC(2026, 8, 28);

function event(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "sold-out-show",
    name: "Sold-out show",
    category: "concert",
    venue: "Arena",
    city: "Budapest",
    description: "",
    startsAtMs: NOW + 24 * 60 * 60 * 1000,
    totalSeats: 120,
    seatsSold: 120,
    priceCents: 7900,
    createdAtMs: NOW,
    cancelledAtMs: null,
    ...overrides,
  };
}

describe("eventStatus sold-out boundary", () => {
  it("marks an event with exactly zero seats left as sold out", () => {
    expect(eventStatus(event(), NOW)).toBe("sold-out");
  });
});
