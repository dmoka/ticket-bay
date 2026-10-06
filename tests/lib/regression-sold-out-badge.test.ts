import { describe, expect, it } from "vitest";
import { eventStatus } from "@/lib/status";
import type { EventRow } from "@/src/db/schema";

describe("sold-out event status", () => {
  it("reports sold out when every seat has been sold", () => {
    const nowMs = Date.UTC(2026, 9, 6);
    const event: EventRow = {
      id: "nova-kings",
      name: "Nova Kings",
      category: "concert",
      venue: "Main Hall",
      city: "Budapest",
      description: "",
      startsAtMs: nowMs + 86_400_000,
      totalSeats: 100,
      seatsSold: 100,
      priceCents: 5_000,
      createdAtMs: nowMs - 86_400_000,
      cancelledAtMs: null,
    };

    expect(eventStatus(event, nowMs)).toBe("sold-out");
  });
});
