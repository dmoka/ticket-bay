import { cookies } from "next/headers";

/**
 * The app's single source of "now". In production it is the wall clock.
 * With TICKETBAY_TEST_CLOCK=1 (the Playwright suite only), a request can carry
 * a `tb-test-now` cookie to be served as of that instant — the only way a
 * browser test can stand on either side of an event's start time.
 */
export const TEST_CLOCK_COOKIE = "tb-test-now";

export async function now(): Promise<number> {
  if (process.env.TICKETBAY_TEST_CLOCK === "1") {
    const raw = (await cookies()).get(TEST_CLOCK_COOKIE)?.value;
    const ms = raw === undefined ? NaN : Number(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}
