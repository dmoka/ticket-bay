import { describe, expect, it } from "vitest";
import { time } from "@/lib/format";

describe("event time display", () => {
  it("shows Budapest local time instead of UTC", () => {
    const midnightArcadeStartsAt = Date.parse("2026-10-07T18:00:00Z");

    expect(time(midnightArcadeStartsAt)).toBe("20:00");
  });
});
