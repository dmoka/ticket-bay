# TicketBay — an AI Agent Testing Team You Can Steal

A demo booking platform wired with a **team of five AI tester agents** for [Claude Code](https://claude.com/claude-code) — the "defense system" from my YouTube video on catching the bugs AI writes.

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

The repo ships with an AI-written refund module and an AI-written test suite. Six tests. All green.

```bash
npm install
npm test              # 6/6 passing. Looks done, right?
npm run test:mutation # mutation score ~68%. 10 surviving mutants.
```

Open `reports/mutation/mutation.html` and look at `src/refund.ts` line 21: Stryker flips the discount math from multiply to divide — **the bigger the discount, the bigger the refund** — and every single test stays green. That's the bug class your green suite can't see, and the exact thing this team exists to catch.

## Steal it

1. Copy `.claude/agents/` into any repo.
2. Copy the loop rules from `CLAUDE.md` into yours.
3. Ask Claude Code to run the testers after any change.

That's the whole install.

---

Built by [Daniel Moka](https://danielmoka.com) — software craftsmanship for the AI era. The full walkthrough is on [YouTube](https://www.youtube.com/@DanielMoka) and in my [newsletter](https://craftbettersoftware.com).
