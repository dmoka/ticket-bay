import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://localhost:4173" },
  webServer: {
    command: "npx tsx server/server.ts",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
