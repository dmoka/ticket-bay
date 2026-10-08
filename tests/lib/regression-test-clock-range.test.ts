import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { nowFor, TEST_CLOCK_COOKIE } from "../../lib/clock";

// A tb-test-now cookie past what a Date can hold (±8.64e15 ms) was served as
// "now"; the first `new Date(now).toISOString()` in a route handler threw and
// the API answered 500. Such a value now counts as no cookie, like any other
// value that is not a usable instant: the wall clock answers.

const WALL = Date.UTC(2026, 9, 8, 12, 0);
const withCookie = (value: string) => new Request("http://localhost:3000/api/v1/events", { headers: { cookie: `${TEST_CLOCK_COOKIE}=${value}` } });

beforeEach(() => {
  vi.stubEnv("TICKETBAY_TEST_CLOCK", "1");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(WALL);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("nowFor: the test clock cookie", () => {
  it("ignores an instant past the Date range and answers with the wall clock", () => {
    for (const value of ["8640000000000001", "-8640000000000001", "1e300", String(Number.MAX_SAFE_INTEGER)]) {
      expect(nowFor(withCookie(value)), value).toBe(WALL);
    }
  });

  it("serves the instants at the very edge of the Date range, and each one is a valid Date", () => {
    for (const ms of [8.64e15, -8.64e15]) {
      const now = nowFor(withCookie(String(ms)));
      expect(now).toBe(ms);
      expect(() => new Date(now).toISOString()).not.toThrow();
    }
  });

  it("still ignores a value that is not a number", () => {
    expect(nowFor(withCookie("not-a-time"))).toBe(WALL);
  });
});
