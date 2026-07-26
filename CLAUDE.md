# TicketBay — Multi-Critic Testing Loop

This repo runs a **multi-critic loop**: one coding agent writes code, five independent tester subagents try to tear it apart, and the code isn't done until all five come back green.

## The loop

1. The **coder** (the main Claude Code session) writes or changes code.
2. All five testers run as subagents, **in parallel**: `integration-tester`, `mutation-tester`, `property-tester`, `ui-tester`, `adversarial-tester` (definitions in `.claude/agents/`).
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

## The two rules (non-negotiable)

1. **The coder never touches the tests.** When agents are graded by tests and can edit those tests, they will eventually edit the test instead of fixing the bug. The exam paper stays locked away from the student. Test changes come only from the tester subagents or a human.
2. **Testers write tests, never source — and start with fresh context.** They may add or heal tests in their own lane, but the source code is read-only for them. And they never see the coder's reasoning — only the code. A critic that shares the author's context inherits the author's blind spots. Five critics only help if they're five independent pairs of eyes.

## Commands

- `npm test` — run the test suite
- `npm run test:mutation` — Stryker mutation testing (report: `reports/mutation/mutation.html`)
- `npm run test:mutation:integration` — mutation testing for `src/orders-repo.ts`, which
  only the integration lane covers. Needs Docker, runs at concurrency 1 on purpose, ~65s.
- `npm run test:integration` — integration tests (Testcontainers; requires Docker)
- `npm run test:ui` — Playwright flows
