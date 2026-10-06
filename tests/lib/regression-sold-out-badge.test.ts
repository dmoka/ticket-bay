import { expect, it } from "vitest";
import { eventStatus } from "@/lib/status";
import type { EventRow } from "@/src/db/schema";

it("marks an upcoming event with no seats left as sold out", () => {
  const nowMs = Date.UTC(2026, 9, 6);
  const event = {
    id: "nova-kings",
    name: "Nova Kings",
    category: "concert",
    venue: "Arena",
    city: "Budapest",
    description: "",
    startsAtMs: nowMs + 86_400_000,
    totalSeats: 100,
    seatsSold: 100,
    priceCents: 5_000,
    createdAtMs: nowMs,
    cancelledAtMs: null,
  } satisfies EventRow;

  expect(eventStatus(event, nowMs)).toBe("sold-out");
});
