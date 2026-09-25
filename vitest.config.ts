import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirrors tsconfig.json's "@/*": ["./*"] so tests can import app code that
// uses "@/..." paths (lib/, app/), the same way Next.js resolves them.
export const alias = { "@": path.dirname(fileURLToPath(import.meta.url)) };

// This list REPLACES vitest's built-in defaults, so every pattern has to be
// spelled out. The globs are matched against the path from the root, hence
// the leading `**/` — plain `node_modules/**` matches only the top level and
// lets vitest walk into a Stryker sandbox's own copy of node_modules.
export const exclude = [
  "**/node_modules/**",
  // Stryker copies the whole repo — tests, e2e specs and mutated source —
  // into here while it runs. Collecting it turns `npm test` red for reasons
  // that have nothing to do with your code, and it is gitignored, so the
  // noise never shows up in `git status`.
  "**/.stryker-tmp/**",
  // Agent worktrees are checkouts of this same repo living inside it, so
  // every test file appears twice and every count doubles. Same hazard as
  // the Stryker sandbox above: a tool writing a copy of the project into a
  // directory the test runner is happy to walk.
  "**/.claude/worktrees/**",
  // Playwright specs run under their own runner (npm run test:ui).
  "e2e/**",
  "**/.next/**",
];

export default defineConfig({
  test: {
    // Everything: tests/domain (unit + property), tests/payments, tests/lib and
    // tests/integration against a real Postgres. The global setup starts ONE
    // Postgres container for the whole run (Testcontainers — Docker must be
    // running) and stops it at the end. Unit tests alone, without Docker:
    // `npm run test:unit` (vitest.unit.config.ts).
    globalSetup: ["tests/integration/global-setup.ts"],
    // Starting a container and cloning a database can take a few seconds on a
    // cold Docker; the default 10s hook timeout is too tight for that.
    hookTimeout: 60_000,
    exclude,
  },
  resolve: { alias },
});
