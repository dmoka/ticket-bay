import { describe, it, expect } from "vitest";
import { eventStatus } from "../../lib/status";
import type { EventRow } from "@/src/db/schema";

function makeEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "ev1",
    name: "Nova Kings — Arena Show",
    category: "concert",
    venue: "Arena",
    city: "Metropolis",
    description: "",
    startsAtMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
    totalSeats: 100,
    seatsSold: 100,
    priceCents: 4_000,
    createdAtMs: Date.now(),
    cancelledAtMs: null,
    ...overrides,
  } as EventRow;
}

describe("eventStatus", () => {
  it("reports sold-out, not few-left, when every seat is sold", () => {
    const ev = makeEvent({ totalSeats: 100, seatsSold: 100 });
    expect(eventStatus(ev, Date.now())).toBe("sold-out");
  });
});
