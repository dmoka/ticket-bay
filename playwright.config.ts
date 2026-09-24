import { defineConfig } from "@playwright/test";
import { E2E_DATABASE, E2E_PORT } from "./e2e/support/env";

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
  // One production build of the real app over its own SQLite file. Specs never
  // share a venue: each creates its own event (support/app.ts), so parallel
  // workers cannot eat each other's seats. TICKETBAY_TEST_CLOCK lets a spec
  // move "now" for its own browser context only (lib/clock.ts).
  webServer: {
    command: `rm -f ${E2E_DATABASE} ${E2E_DATABASE}-wal ${E2E_DATABASE}-shm && npm run db:migrate && npm run build && npx next start -p ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      DATABASE_PATH: E2E_DATABASE,
      TICKETBAY_TEST_CLOCK: "1",
      STRIPE_SECRET_KEY: "sk_test_e2e",
    },
  },
});
