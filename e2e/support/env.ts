// Everything the e2e suite and its server agree on. Fixed instants, not
// "Date.now() + 10 days": the specs set the app's clock (a cookie honored only
// under TICKETBAY_TEST_CLOCK=1, see lib/clock.ts), so every amount on every
// page is the same on every run.
export const E2E_PORT = 3217;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
/** Signs this run's sessions only. Throwaway, like the container it runs against. */
export const E2E_AUTH_SECRET = "e2e-only-3f9a1c7e5b2d8f4a6c0e9b1d3f5a7c2e";

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
  adminCancel: "e2e-admin-cancel",
} as const;

export const E2E_CODE = { code: "WELCOME10", percent: 10 } as const;

/** Every seeded account's password (Better Auth wants at least 8 characters). */
export const E2E_PASSWORD = "e2e-password-123";

export interface E2EUser {
  name: string;
  email: string;
  admin?: boolean;
}

/**
 * One account per spec, so "My orders" and the API key list only ever show
 * that spec's own rows — parallel workers never see each other's data.
 */
export const E2E_USERS = {
  discount: { name: "Dora Discount", email: "discount@e2e.test" },
  refundInWindow: { name: "Rita Refund", email: "refund-in-window@e2e.test" },
  refundAfterStart: { name: "Lars Late", email: "refund-after-start@e2e.test" },
  developer: { name: "Dev Keys", email: "developer@e2e.test" },
  fanA: { name: "Ann Fan", email: "fan-a@e2e.test" },
  fanB: { name: "Bob Fan", email: "fan-b@e2e.test" },
  admin: { name: "Olga Admin", email: "admin@e2e.test", admin: true },
} as const satisfies Record<string, E2EUser>;
