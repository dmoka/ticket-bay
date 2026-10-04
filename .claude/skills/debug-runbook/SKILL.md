---
name: debug-runbook
description: "TicketBay looks wrong? Find out why before fixing it. Use when something in TicketBay is broken, wrong or surprising and you need the cause: a refund, price, discount, badge or seat count that looks off, a customer asking why, a failing test, or an MCP tool error. Decides bug or policy first, reproduces it red, knows where to look and the usual causes in this codebase, and the traps that look like code bugs but are config. Investigation only; once the cause is known, the bug-triage skill does the fix-and-PR process."
---

# TicketBay debug runbook

What this codebase won't tell you by reading it once. Work the steps in order; each ends on its done-check.

## Steps

1. **Bug or policy?** Find the matching page in `help/` via [references/not-a-bug.md](references/not-a-bug.md). Done when you can quote the rule the behaviour follows, or name exactly where it departs from it. If it follows the rule, report "works as designed" with the quote and stop.
2. **Make it red.** Write the smallest test that shows the report, in a new file `tests/domain/regression-<slug>.test.ts` (code in `src/domain`) or `tests/lib/regression-<slug>.test.ts` (code in `lib/`), and run `scripts/repro.sh <that file>`. Done when it is red for the reported reason — an import or config error is not red yet (see Gotchas).
3. **Look in this order:** the red test's output → the dev server's terminal (`npm run dev` prints server errors; there is no log file) → the data: `scripts/db-peek.sh event <id>` or `scripts/db-peek.sh order <id>`.
4. **Match a usual cause.** Check [references/usual-causes.md](references/usual-causes.md); most TicketBay bugs are one of the seven there. If the area is unfamiliar, [references/where-things-live.md](references/where-things-live.md) maps it.
5. **Ask what changed.** `scripts/recent-changes.sh <path>` lists the recent commits touching that area.
6. **Fix the smallest thing** that turns the test green, then `npm run test:unit`. Done when everything is green and the only changes are the fix and the new test.

A finished case, start to end: [examples/sold-out-badge.md](examples/sold-out-badge.md).
For the fix-and-PR process after the cause is known, the bug-triage skill takes over.

## Gotchas

- **A test that fails on import is config, not the bug.** "Cannot find module '@/…'" means the test sits outside the unit folders or the alias is missing: the `@/` alias is exported from `vitest.config.ts` and reused by `vitest.unit.config.ts`, which runs `tests/domain`, `tests/payments` and `tests/lib` only. Put the test there; leave both configs as they are.
- **Integration and UI tests need Docker.** `tests/integration` and `e2e/` start Postgres with Testcontainers. A box started with plain `./box` has no Docker, so there they fail with a Docker error; a box started with `./box --docker` runs them. Reproduce at unit level first; the heavy tests also run in CI.
- **Refunds are based on `ticketsCents`**, what the tickets cost after discounts — `toDomainOrder` (`src/db/orders-repo.ts`) maps it into `Order.totalCents`. The service fee is never part of a refund.
- **Time is always passed in.** Domain functions take `nowMs`; the app reads `now()` from `lib/clock.ts`, and Playwright moves time with the `tb-test-now` cookie when `TICKETBAY_TEST_CLOCK=1`. Tests use fixed instants.
- **The `loop-test` branch carries a planted demo bug** (the sold-out badge) for the course; `main` is clean. Fix bugs against the branch you were given.
- **Money is integer cents end to end** (bigint columns in `src/db/schema.ts`). A float or a euro amount in a test is a bug in the test.

Last verified: 2026-09-29 with Claude Code 2.1.284 (5 of 5 automatic picks on a buried planted bug)
