import { cookies } from "next/headers";

/**
 * The app's single source of "now". In production it is the wall clock.
 * With TICKETBAY_TEST_CLOCK=1 (the Playwright suite and the HTTP tests only),
 * a request can carry a `tb-test-now` cookie to be served as of that instant
 * — the only way a test from outside can stand on either side of an event's
 * start time.
 */
export const TEST_CLOCK_COOKIE = "tb-test-now";

/** The largest instant a Date can hold, in ms: ECMAScript time values run from -8.64e15 to 8.64e15. */
const MAX_DATE_MS = 8.64e15;

function testClock(raw: string | undefined): number | null {
  if (process.env.TICKETBAY_TEST_CLOCK !== "1") return null;
  const ms = raw === undefined ? NaN : Number(raw);
  // A value a Date cannot hold counts as no cookie, like a value that is not a number: the wall clock answers.
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : null;
}

export async function now(): Promise<number> {
  if (process.env.TICKETBAY_TEST_CLOCK === "1") {
    const ms = testClock((await cookies()).get(TEST_CLOCK_COOKIE)?.value);
    if (ms !== null) return ms;
  }
  return Date.now();
}

/**
 * The same clock for a route handler, read from the request it was handed —
 * so the handler also runs outside Next's request scope (the HTTP tests call
 * it in-process with a plain Request).
 */
export function nowFor(request: Request): number {
  const cookie = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${TEST_CLOCK_COOKIE}=`));
  return testClock(cookie?.slice(TEST_CLOCK_COOKIE.length + 1)) ?? Date.now();
}
