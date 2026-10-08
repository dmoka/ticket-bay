# TicketBay

## Writing tests

- **Test behavior through the public API**: the route handlers and the `src/domain` / `src/services` functions the app calls. Never test private helpers, never assert on internal calls, never mock our own modules. A refactor that changes no behavior must not break a test; if it does, the test was testing the implementation.
- **Never mark a mutant equivalent yourself.** When the CI mutation check finds a survivor, write a test that kills it. If you believe it cannot be killed (the change does not change behavior), stop and ask the human, with the reason. Only after a yes add `// Stryker disable next-line <Mutator>: equivalent — <why>`. In a loop with nobody watching, leave the PR red and put the question in your report.

## Fixing a reported bug

The bug-triage skill (github.com/dmoka/skills) reads this section.

- **Where a regression test goes:** a new file `tests/domain/regression-<short-slug>.test.ts` for code in `src/domain`, or `tests/lib/regression-<short-slug>.test.ts` for code in `lib/`. The unit test config already runs both folders; do not edit it.
- **The fast test suite:** `npm run test:unit` is the one that runs without Docker; use it for the regression test.
