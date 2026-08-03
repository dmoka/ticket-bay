import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // This list REPLACES vitest's built-in defaults, so every pattern has to be
    // spelled out. The globs are matched against the path from the root, hence
    // the leading `**/` — plain `node_modules/**` matches only the top level and
    // lets vitest walk into a Stryker sandbox's own copy of node_modules.
    exclude: [
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
      "tests/integration/**",
      "e2e/**",
    ],
  },
});
