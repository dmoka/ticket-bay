# TicketBay — Multi-Critic Testing Loop

This repo runs a **multi-critic loop**: one coding agent writes code, five independent tester subagents try to tear it apart, and the code isn't done until all five come back green.

## The loop

1. The **coder** (the main agent session) writes or changes code.
2. All five testers run as subagents, **in parallel**: `integration-tester`, `mutation-tester`, `property-tester`, `ui-tester`, `adversarial-tester` (in Claude Code: `.claude/agents/`; in other harnesses, hand each tester's brief to a fresh subagent).
3. All five green → done, ship it.
4. Any failure → collect every finding into one report, hand it back to the coder, fix, go again.
5. **Maximum 3 rounds.** Not converging by round 3 → stop and escalate to a human.

### What "green" means per lane

Four lanes are green when their tests pass. `mutation-tester` is the exception:
green means **no surviving mutant can change an amount the system pays anyone**,
not zero survivors. Equivalent mutants exist and nobody can kill them — demanding
zero makes the loop unable to converge. A single payout-changing survivor is red
however high the score.

A lane that could not run (no Docker, browsers missing, a red baseline that makes
Stryker refuse) reports **BLOCKED**, never green. Blocked is not a pass.

## The rule (non-negotiable)

**Testers write tests, never source — and start with fresh context.** They may add or heal tests in their own lane, but the source code is read-only for them. And they never see the coder's reasoning — only the code. A critic that shares the author's context inherits the author's blind spots. Five critics only help if they're five independent pairs of eyes.

## Commands

- `npm test` — run the test suite (unit + Postgres integration; needs Docker)
- `npm run test:unit` — domain, payments and formatting tests only (no Docker)
- `npm run test:mutation` — Stryker mutation testing on `src/domain` (report: `reports/mutation/mutation.html`)
- `npm run test:mutation:integration` — mutation testing for `src/db` and `src/services`, which
  only the integration lane covers. Needs Docker, runs at concurrency 1 on purpose.
- `npm run test:integration` — integration tests (Testcontainers Postgres; requires Docker)
- `npm run test:ui` — Playwright flows (critical money paths only; Testcontainers Postgres)

## Fixing a reported bug

The bug-triage skill (github.com/dmoka/skills) reads this section.

- **Where the code lives:** business rules in `src/domain` (money, refunds, booking, pricing), use cases in `src/services`, database access in `src/db`, small helpers in `lib/`, the UI in `app/`.
- **Where a regression test goes:** a new file `tests/domain/regression-<short-slug>.test.ts` for code in `src/domain`, or `tests/lib/regression-<short-slug>.test.ts` for code in `lib/`. The unit test config already runs both folders; do not edit it.
- **The fast test suite:** `npm ci`, then `npm run test:unit` (no Docker needed).
- **Imports:** tests may import app code with the `@/` alias (it is set up for the unit tests).
