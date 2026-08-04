# TicketBay — an AI Agent Testing Team You Can Steal

A demo booking platform wired with a **team of five AI tester agents** for [Claude Code](https://claude.com/claude-code) — the "defense system" from [my YouTube video](https://youtu.be/0K-5p6SgjSM) on catching the bugs AI writes.

AI writes code faster than you can review it. This repo shows the answer: don't review harder — **build a loop where independent agents test everything**, and the code isn't done until all of them come back green.

## The five testers (`.claude/agents/`)

| Agent | Job | Its one rule |
|---|---|---|
| [`integration-tester`](.claude/agents/integration-tester.md) | Runs tests against **real** dependencies (Testcontainers: real Postgres, real broker) | A test that mocks the database is a finding, not coverage |
| [`mutation-tester`](.claude/agents/mutation-tester.md) | Runs Stryker, explains every surviving mutant as the lie your suite is telling | One surviving mutant in money code outranks any score |
| [`property-tester`](.claude/agents/property-tester.md) | Writes fast-check properties — thousands of generated inputs against your invariants | State the rule in English first, then encode it |
| [`ui-tester`](.claude/agents/ui-tester.md) | Playwright flows on the money paths | Assert what the user sees, never that the page loaded |
| [`adversarial-tester`](.claude/agents/adversarial-tester.md) | Reads the code hunting shortcuts, reads the tests hunting what they avoid, writes the tests that break green suites | It succeeds when green turns red |

The five run as **Claude Code subagents** in a multi-critic loop — one coder, five critics, max 3 rounds, coder never touches the tests. Loop rules in [`CLAUDE.md`](CLAUDE.md).

## See it catch a real bug

The repo ships with an AI-written refund module and an AI-written test suite — all green. The branch `demo/loop-recording` carries a planted defect: the docstring promises *"cancellations are only allowed before the event starts"*, and the code never checks the clock. Cancel after the show → full refund. Every test stays green (none of them touches a date).

```bash
git checkout demo/loop-recording
npm install
npm test              # all green. Looks done, right?
```

Then run the loop (see `CLAUDE.md`): the testers read the docstring against the code, write the cancel-after-showtime test nobody wrote, and go red. The coder fixes the code — it can't touch the tests — and round two is green.

The suite is not thin, either. That's the point. `npm run test:mutation` scores **95%** with zero uncovered mutants, and every surviving mutant is provably equivalent. A near-perfect mutation score, on code that will refund a sold-out stadium the morning after the show.

That is the lesson worth taking: mutation testing grades the tests you have against the code you *wrote*. A business rule that was never implemented generates no mutants, so it cannot lower your score. No coverage tool will ever tell you about code that isn't there — only a critic reading the spec against the behaviour will.

## Steal it

1. Copy `.claude/agents/` into any repo.
2. Copy the loop rules from `CLAUDE.md` into yours.
3. The example attacks reference this repo's domain (money, refunds, ticket counts) on purpose — concrete examples make agents sharper than generic instructions. Swap them for your domain's equivalents: the attack *shapes* (boundaries, odd splits, degenerate inputs, the gap between code and tests) are what transfer.
4. Ask Claude Code to run the testers after any change.

That's the whole install.

---

Built by [Daniel Moka](https://danielmoka.com) — software craftsmanship for the AI era. The full walkthrough is on [YouTube](https://www.youtube.com/@DanielMoka) and in my [newsletter](https://craftbettersoftware.com).
