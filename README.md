# TicketBay

The reference app for the **AI Agent Engineer** course: a small but real ticketing platform — storefront, checkout, order management and an ops dashboard — built so that AI coding agents have something worth breaking.

- **Stack:** Next.js (App Router, server actions), TypeScript, Postgres 17 via Drizzle ORM + node-postgres (`pg`), shadcn/ui, Recharts. Docker runs the database locally (docker-compose) and in tests (Testcontainers).
- **Domain:** framework-free modules in `src/domain` — group discounts, early-bird, discount codes, service fee, VAT, and time-window refunds. Money is integer cents everywhere.
- **Payments:** a fake, Stripe-shaped provider in `src/payments` (no network, idempotency keys). Configure it with `STRIPE_SECRET_KEY` — see `.env.example`.

## Run it

Needs Node 22 and a running Docker.

```bash
npm install && npm run db:up && npm run db:migrate && npm run db:seed && npm run dev
```

Then open http://localhost:3000 (storefront) and http://localhost:3000/admin (dashboard). The seed creates 8 events, ~300 orders over the last 60 days and two accounts, both with the password `ticketbay-demo`:

| Account | Role | What it has |
|---|---|---|
| `anna@ticketbay.test` | customer | a history of orders under **My orders** |
| `admin@ticketbay.test` | admin | the `/admin` dashboard |

Accounts, sessions and API keys are [Better Auth](https://www.better-auth.com) on the same Postgres (`src/auth/auth.ts`). Serving on another port? Set `BETTER_AUTH_URL` to match, e.g. `PORT=3100 BETTER_AUTH_URL=http://localhost:3100 npm run dev`.

## The MCP server

TicketBay is also an MCP server, so a customer's AI agent can browse, book and refund for them. The tools are defined once in `src/mcp/tools.ts` and served two ways:

| | Local | Remote |
|---|---|---|
| Entry | `mcp/server.ts` (stdio) | `app/api/mcp/route.ts` (Streamable HTTP, `/api/mcp`) |
| Tools | public: `list_events`, `get_event`, `quote_price`, `search_docs` | public + private: `my_orders` (read), `book_tickets`, `refund_order`, `cancel_event` (write; `cancel_event` is admin-only and only returns a link) |
| Auth | none — the client starts it on your machine | `Authorization: Bearer tb_…`, a key from **Settings → Developers** — **Read only** or **Read & write** |

```bash
# local, public tools
claude mcp add ticketbay-local -- npx tsx "$PWD/mcp/server.ts"
# remote, as a customer (create the key under Settings → Developers)
claude mcp add --transport http ticketbay http://localhost:3000/api/mcp --header "Authorization: Bearer tb_…"
```

Without a key the public tools still work; a private tool answers `401` and says how to get a key. A read-only key can see your orders but is refused (`403`) on booking and refunds. `search_docs` answers policy questions from the help pages in [`help/`](help/). Dangerous actions only return a link: `cancel_event` points an admin at `/admin/events/<id>/cancel`, and nothing is cancelled until they confirm there.

Self-hosted agents take the key the same way. [Hermes](https://github.com/NousResearch/hermes-agent), in `~/.hermes/config.yaml` with `TICKETBAY_API_KEY=tb_…` in `~/.hermes/.env`:

```yaml
mcp_servers:
  ticketbay:
    url: "http://localhost:3000/api/mcp"   # an address the machine running Hermes can reach
    headers:
      Authorization: "Bearer ${TICKETBAY_API_KEY}"
    tools:
      exclude: [cancel_event]              # optional: what this agent never sees
```

Which clients accept a key header (and which would need OAuth): [`docs/mcp-client-auth-2026.md`](docs/mcp-client-auth-2026.md). The end-to-end proof: [`docs/mcp-e2e-2026.md`](docs/mcp-e2e-2026.md).

`npm run db:up` starts Postgres 17 from `docker-compose.yml` (port 5432, named volume `ticketbay-pg`) and waits until it is healthy. Its local-only credentials and `DATABASE_URL` live in `.env.example`; the scripts read it when there is no `.env`. Copy it to `.env` to change anything. `npm run db:down` stops the database; `docker compose down -v` also deletes its data.

| Command | What it runs |
|---|---|
| `npm test` | Vitest: domain unit + property tests, payments, and the integration tests against a real Postgres (Testcontainers starts one container for the run) |
| `npm run test:unit` | The same minus the integration tests — no Docker needed |
| `npm run test:integration` | Only the Postgres integration tests |
| `npm run test:ui` | Playwright: the critical money paths against a production build and its own Postgres container |
| `npm run test:mutation` | Stryker on `src/domain` (unit lane) |
| `npm run typecheck` / `npm run build` | `tsc --noEmit` / production build |

**Test with real databases.** The integration lane never mocks the database. `tests/integration/global-setup.ts` starts one throwaway Postgres container per run and migrates a template database. Each test file clones its own database from that template, and every test starts from empty tables (`TRUNCATE`). The race tests open two real connections that commit and block on each other's row locks — which is why isolation is by truncation and not by a rolled-back transaction around each test.

**Playwright for critical flows only.** `e2e/` holds three flows: booking with a discount code, a refund inside the window, and a refund refused once the event has started. Everything else is pinned faster one layer down.

## The testing team

This repo is also wired with a **team of five AI tester agents** for [Claude Code](https://claude.com/claude-code) — the "defense system" from [my YouTube video](https://youtu.be/0K-5p6SgjSM) on catching the bugs AI writes. The agent definitions predate the Next.js rewrite and will be updated for it.

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
