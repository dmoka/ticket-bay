// Everything the e2e suite and its server agree on. Fixed instants, not
// "Date.now() + 10 days": the specs set the app's clock (a cookie honored only
// under TICKETBAY_TEST_CLOCK=1, see lib/clock.ts), so every amount on every
// page is the same on every run.
export const E2E_PORT = 3217;

const DAY = 86_400_000;

/** Every seeded event starts at this instant. */
export const EVENT_START_MS = Date.UTC(2031, 5, 1, 18, 0, 0);
/** When customers book: ten days out — inside the refund window, outside early-bird. */
export const BOOKING_AT_MS = EVENT_START_MS - 10 * DAY;

/** One event per spec, so parallel workers never share seats. */
export const E2E_EVENTS = {
  discount: "e2e-discount",
  refundInWindow: "e2e-refund-in-window",
  refundAfterStart: "e2e-refund-after-start",
} as const;

export const E2E_CODE = { code: "WELCOME10", percent: 10 } as const;
