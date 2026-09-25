# MCP build plan — TicketBay v2, course module 6

Branch `app/v2-mcp` from `app/v2`. Local only: small commits, never pushed.
Decisions come from the grilling on 2026-09-25 (see "Decisions") and from
`second-brain/docs/crash-course-content/m6/notes.md`.

## Decisions

| # | Question | Answer |
|---|---|---|
| Q1 | Who owns an order? | Sign-in to book. `orders.user_id` → Better Auth `user.id`. Checkout and My orders need a session; the email lookup goes. The column stays nullable only so pre-account rows (and the locked existing tests) keep working; every new order from the UI or MCP carries a user. |
| Q2 | Is `refund_order` link-only? | No. The agent refunds its own order (same refund rules as the UI) and gets the order URL back. |
| Q3 | Admin? | `/admin` gated by the Better Auth admin plugin (`user.role = "admin"`), one seeded admin. `cancel_event` is an admin-only tool that only returns a deep link; the admin confirms in the UI. |
| Q4 | Who writes tests? | The repo rule: the coder never touches tests. The `integration-tester` subagent writes the new tests, then the five-critic loop runs (max 3 rounds). |
| Q5 | OAuth test from a chat app? | Localhost only. Claude.ai / ChatGPT connectors need a public HTTPS URL; not exposed on purpose. Client OAuth requirements come from official docs, cited. |

## Stack (verified 2026-09-25)

- `better-auth` 1.7.6 + Drizzle adapter on the same Postgres; plugins: `admin`,
  `@better-auth/api-key` (prefix `tb_`), `jwt` + `@better-auth/mcp` + `@better-auth/cimd`
  (profile `mcp-2026-07-28`, no DCR).
- `@modelcontextprotocol/server` 2.1.0 — SDK v2, the 2026-07-28 spec. `createMcpHandler`
  for HTTP (default `legacy: "stateless"`, so 2025-era clients still work), `serveStdio`
  for the local server. `zod` 4.

## Build order (each step works before the next)

1. **Accounts.** Better Auth tables in `src/db/auth-schema.ts` + Drizzle migration;
   `lib/auth.ts`, `/api/auth/[...all]`, sign-in / sign-up pages in the distdash look,
   header shows the user. `orders.user_id`; checkout + My orders use the session; order
   detail/cancel checks ownership. Seed: Anna and Ben (customers), one admin. `/admin`
   requires role admin.
2. **Settings → Developers.** `/settings/developers`: create (plaintext shown once),
   list (name, `tb_…` start, created, last used), revoke, rotate (new key, old one
   deleted). Server actions over `auth.api.*`.
3. **Local stdio server.** `src/mcp/tools.ts` registers tools on an `McpServer` from a
   caller context; `mcp/server.ts` serves the public tools over stdio: `list_events`
   (date window, max price, category, city), `get_event` (seats left, price tiers,
   early-bird), `quote_price` (quantity + code → line items). Tools call the existing
   services/repos, never duplicate rules. Connect with `claude mcp add`.
4. **Remote `/api/mcp`.** Same factory over Streamable HTTP. Caller resolution:
   `Bearer tb_…` → API key → user; other Bearer → OAuth access token (JWKS) → user;
   none → anonymous. Private tools: `book_tickets`, `my_orders`, `refund_order` (owner
   check), `cancel_event` (admin only). Anonymous private call → clear 401-style error.
5. **Deep links.** `refund_order` returns `/orders/<id>`; `cancel_event` returns
   `/admin/events?cancel=<id>` and changes nothing. The admin UI gets a Cancel event
   dialog: event marked cancelled, sales stop, every paid order refunded (ticket amount
   in full, no cancellation fee; the booking fee rule stays as the schema defines it).
6. **OAuth.** `mcp()` + `cimd()` + `jwt()`, consent page, protected resource metadata.
   Test on localhost with Claude Code (and MCP Inspector if Claude Code cannot).
   Research + report which clients need OAuth vs accept a header.
7. **Tests.** `integration-tester` writes: key → user mapping, refund ownership, public
   tools without a key, revoked key. Then all five lanes; heal only in-lane.
8. **Proof.** `docs/mcp-e2e-2026.md` with exact commands + outputs (real `claude -p`
   sessions), screenshots in `docs/`.

## Risks

- Claude Code may not start OAuth on a 401 from a tool call (only at connect) → test;
  fall back to documenting the exact behaviour.
- Claude Code may speak only the 2025 protocol → SDK serves it via the stateless
  legacy path; OAuth then needs the client to support CIMD or it fails (DCR is off).
- Port 5432 clash with other local Postgres → check before `db:up`.

## Scope change (2026-09-25, evening)

Course decision: agents connect with the customer's API key, so step 6 (MCP OAuth via the
Better Auth MCP plugin + CIMD) is dropped from `app/v2-mcp`. It was already built and proven
(Claude Code, CIMD, localhost) — that work is kept on the local branch `app/v2-mcp-oauth`
and in `docs/mcp-e2e/oauth/`. Also: one demo customer; `cancel_event` links to the event's
own cancel page; `search_docs` over `help/`; key scopes (Read only / Read & write).
Caveat recorded in `docs/mcp-client-auth-2026.md`: ChatGPT cannot send API keys, and
Claude.ai key headers are a limited beta — chat apps mostly still need OAuth.
