import { describe, expect, it } from "vitest";
import { eventStatus } from "@/lib/status";
import type { EventRow } from "@/src/db/schema";

describe("sold-out homepage badge regression", () => {
  it("marks a future event with zero remaining seats as sold out", () => {
    const nowMs = Date.UTC(2026, 8, 28);
    const event = {
      id: "nova-kings-arena",
      name: "Nova Kings — Arena Show",
      category: "concert",
      venue: "TicketBay Arena",
      city: "Budapest",
      description: "",
      startsAtMs: nowMs + 86_400_000,
      totalSeats: 1_000,
      seatsSold: 1_000,
      priceCents: 10_000,
      createdAtMs: nowMs - 86_400_000,
      cancelledAtMs: null,
    } satisfies EventRow;

    expect(eventStatus(event, nowMs)).toBe("sold-out");
  });
});
