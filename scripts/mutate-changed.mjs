#!/usr/bin/env node
// CI mutation lane: mutate ONLY the lines this change touched in src/domain,
// and fail on any surviving mutant there.
//
// Why changed lines only: the full domain run takes minutes and already has a
// few survivors that are provably equivalent (see README). Judging a pull
// request on old survivors it didn't touch would make every PR red.
//
// Why "fail on any survivor": AGENTS.md says a payout-changing survivor is red
// however high the score, and equivalent mutants exist. A machine can't tell
// the two apart, so a survivor in changed code fails the gate. If it is truly
// equivalent, mark it in the code with a reason the reviewer will see:
//   // Stryker disable next-line <MutatorName>: equivalent — <why>
//
// Usage: node scripts/mutate-changed.mjs <base-ref>   (e.g. origin/main)
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const base = process.argv[2] ?? "origin/main";
const diff = execFileSync(
  "git",
  ["diff", "--unified=0", `${base}...HEAD`, "--", "src/domain/*.ts", "src/domain/**/*.ts"],
  { encoding: "utf8" },
);

// Collect "file:start-end" ranges of added/changed lines (new side of the diff).
const ranges = [];
let file = null;
for (const line of diff.split("\n")) {
  if (line.startsWith("+++ ")) {
    file = line === "+++ /dev/null" ? null : line.slice(6); // strip "+++ b/"
    continue;
  }
  const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (hunk && file) {
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) ranges.push(`${file}:${start}-${start + count - 1}`);
  }
}

if (ranges.length === 0) {
  console.log("No changed lines in src/domain — nothing to mutate.");
  process.exit(0);
}

console.log(`Mutating ${ranges.length} changed range(s):\n  ${ranges.join("\n  ")}`);

// Same settings as stryker.config.json, narrowed to the changed lines, and
// break below 100%: any survivor (or uncovered mutant) in changed code fails.
const config = {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.unit.config.ts" },
  mutate: ranges,
  ignorePatterns: ["test-results", "playwright-report", "reports", "coverage", ".stryker-tmp", ".next", "data"],
  reporters: ["clear-text", "progress"],
  coverageAnalysis: "perTest",
  thresholds: { high: 100, low: 100, break: 100 },
};
writeFileSync("stryker.changed.json", JSON.stringify(config, null, 2));

try {
  execFileSync("npx", ["stryker", "run", "stryker.changed.json"], { stdio: "inherit" });
} catch {
  console.error(
    "\nA mutant survived in the lines this change touched. Kill it with a test, or, if it is " +
      "truly equivalent, mark it: // Stryker disable next-line <Mutator>: equivalent — <why>",
  );
  process.exit(1);
}
