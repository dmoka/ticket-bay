import { expect, it } from "vitest";
import { eventStatus } from "@/lib/status";
import type { EventRow } from "@/src/db/schema";

it("marks an upcoming event with no remaining seats as sold out", () => {
  const nowMs = 1_000_000;
  const event: EventRow = {
    id: "nova-kings-arena-show",
    name: "Nova Kings — Arena Show",
    category: "concert",
    venue: "Arena",
    city: "Budapest",
    description: "",
    startsAtMs: nowMs + 86_400_000,
    totalSeats: 100,
    seatsSold: 100,
    priceCents: 10_000,
    createdAtMs: nowMs - 86_400_000,
    cancelledAtMs: null,
  };

  expect(eventStatus(event, nowMs)).toBe("sold-out");
});
