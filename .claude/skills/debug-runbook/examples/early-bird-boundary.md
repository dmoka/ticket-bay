# Example: the early-bird discount missing at exactly 30 days

**Report:** "I booked exactly 30 days before the show and got no early-bird discount."

**1. Bug or policy?** `help/early-bird-and-discounts.md`: "Book **at least 30 days before the event** and every ticket is **10% off**." Exactly 30 days is "at least 30", so no discount departs from the rule. Bug.

**2. Red:** `tests/domain/regression-early-bird-30-days.test.ts`

```ts
import { expect, it } from "vitest";
import { earlyBirdApplies } from "../../src/domain/invoice";

it("applies early-bird when booking exactly 30 days before the event", () => {
  const nowMs = Date.UTC(2026, 8, 1);
  expect(earlyBirdApplies({ startMs: nowMs + 30 * 86_400_000 }, nowMs)).toBe(true);
});
```
`scripts/repro.sh tests/domain/regression-early-bird-30-days.test.ts` → red: `expected false to be true`.

**3–4. Cause:** usual cause #1 (a boundary), in the rule of #5. In `src/domain/invoice.ts` the check read `> EARLY_BIRD_DAYS`, so a booking at exactly 30 days fell outside the window.

**5. What changed:** `scripts/recent-changes.sh src/domain/invoice.ts` shows the commit that changed the comparison.

**6. Fix:** `> EARLY_BIRD_DAYS` → `>= EARLY_BIRD_DAYS`. `npm run test:unit` green. Two files changed: the fix and the test.
