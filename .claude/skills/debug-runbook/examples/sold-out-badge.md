# Example: the sold-out event that said "Few left"

**Report:** "Nova Kings has an orange 'Few left' badge, but there are no seats at all."

**1. Bug or policy?** `help/` has no rule for badges; a full event showing "Few left" contradicts the product. Bug.

**2. Red:** `tests/lib/regression-sold-out-badge.test.ts`

```ts
import { expect, it } from "vitest";
import { eventStatus } from "../../lib/status";

it("labels an upcoming event with zero seats left as sold out", () => {
  const nowMs = Date.UTC(2026, 8, 27);
  const event = { /* …a full EventRow… */ startsAtMs: nowMs + 86_400_000, totalSeats: 100, seatsSold: 100, cancelledAtMs: null };
  expect(eventStatus(event as never, nowMs)).toBe("sold-out");
});
```
`scripts/repro.sh tests/lib/regression-sold-out-badge.test.ts` → red: `expected 'few-left' to be 'sold-out'`.

**3–4. Cause:** usual cause #1. In `lib/status.ts` the check read `if (left < 0)`, so an exactly-full event (`left === 0`) fell through to the 10% rule, which is also true for 0.

**6. Fix:** `left < 0` → `left <= 0`. `npm run test:unit` green. Two files changed: the fix and the test.
