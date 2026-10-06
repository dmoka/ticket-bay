import { expect, it } from "vitest";
import { time } from "@/lib/format";

it("shows event start times in Budapest local time", () => {
  const novaKingsStart = Date.UTC(2026, 9, 24, 18, 0);

  expect(time(novaKingsStart)).toBe("20:00");
});
