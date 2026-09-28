import { describe, expect, it } from "vitest";
import { eventStatus } from "@/lib/status";
import type { EventRow } from "@/src/db/schema";

describe("eventStatus sold-out regression", () => {
  it("marks an upcoming event sold out when no seats remain", () => {
    const nowMs = Date.UTC(2026, 8, 28);
    const event = {
      id: "nova-kings-arena",
      name: "Nova Kings — Arena Show",
      category: "concert",
      venue: "MVM Dome",
      city: "Budapest",
      description: "",
      startsAtMs: nowMs + 24 * 60 * 60 * 1000,
      totalSeats: 120,
      seatsSold: 120,
      priceCents: 7900,
      createdAtMs: nowMs,
      cancelledAtMs: null,
    } satisfies EventRow;

    expect(eventStatus(event, nowMs)).toBe("sold-out");
  });
});
