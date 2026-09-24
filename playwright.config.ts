import { defineConfig } from "@playwright/test";
import { E2E_PORT } from "./e2e/support/env";

// Playwright covers the critical money paths only — booking with a discount,
// a refund inside the window, a refund refused after the event starts. Every
// other rule is cheaper and faster to pin in tests/domain or tests/integration.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    // Failures on a money path have to be diagnosable without a rerun.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // A production build of the real app over its own Postgres container, started
  // by e2e/support/server.ts (Testcontainers — Docker must be running), migrated
  // and seeded with one event per spec, so parallel workers never share seats.
  webServer: {
    command: "npm run build && npx tsx e2e/support/server.ts",
    url: `http://localhost:${E2E_PORT}`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
    // Let server.ts stop its container instead of being SIGKILLed.
    gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
  },
});
