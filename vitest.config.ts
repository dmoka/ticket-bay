import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "tests/integration/**", "e2e/**"],
  },
});
