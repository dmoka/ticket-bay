import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://localhost:4173",
    // Failures on a money path have to be diagnosable without a rerun.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx tsx server/server.ts",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
