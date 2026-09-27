import { expect, it } from "vitest";
import { eventStatus } from "../../lib/status";
import type { EventRow } from "../../src/db/schema";

it("labels an upcoming event with zero seats left as sold out", () => {
  const nowMs = Date.UTC(2026, 8, 27);
  const event: EventRow = {
    id: "nova-kings",
    name: "Nova Kings — Arena Show",
    category: "concert",
    venue: "Arena",
    city: "Budapest",
    description: "",
    startsAtMs: nowMs + 86_400_000,
    totalSeats: 100,
    seatsSold: 100,
    priceCents: 10_000,
    createdAtMs: nowMs,
    cancelledAtMs: null,
  };

  expect(eventStatus(event, nowMs)).toBe("sold-out");
});
