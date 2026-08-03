import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    // Failures on a money path have to be diagnosable without a rerun.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // No `webServer` block on purpose. Every spec now boots its own server via
  // e2e/support/harness.ts, so it gets a pristine venue and a controllable
  // clock instead of sharing one process's seat count with every other spec.
  // A shared server here was worse than unused: a leaked one from an earlier
  // run would race its startup check and abort the whole suite with
  // "Process from config.webServer was not able to start".
});
