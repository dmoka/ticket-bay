# TicketBay

## Rules

- Never push to `main`. Every change goes through a pull request, and the six CI checks must pass.
- Never edit the migrations in the `drizzle/` folder by hand. Change the schema, then run `npm run db:generate`.
- Test behavior through the public API: the route handlers and the `src/domain` / `src/services` functions the app calls. Never test private helpers, never assert on internal calls, never mock `src/domain` or `src/services`. The HTTP and integration tests mock only the wiring seams `lib/auth`, `src/db/client` and `src/payments`; their pass-through vi.mock calls for `src/auth` and `src/mcp` re-import the real module.
- Never mark a mutant equivalent yourself. When the CI mutation check finds a survivor, write a test that kills it. If you think it cannot be killed, stop and ask the human, with the reason.
- A regression test goes in a new file `tests/domain/regression-<short-slug>.test.ts` (code in `src/domain`) or `tests/lib/regression-<short-slug>.test.ts` (code in `lib/`). Do not edit the unit test config.
