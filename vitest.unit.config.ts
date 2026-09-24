import { defineConfig } from "vitest/config";
import { exclude } from "./vitest.config";

// The fast lane: domain, payments and formatting tests. No database, no
// Docker, no container start-up — also what Stryker runs for src/domain.
export default defineConfig({
  test: {
    include: ["tests/domain/**/*.test.ts", "tests/payments/**/*.test.ts", "tests/lib/**/*.test.ts"],
    exclude,
  },
});
