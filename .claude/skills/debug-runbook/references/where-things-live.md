# Where things live

| Area | Code | Unit tests |
|---|---|---|
| Money, refunds, booking, pricing, invoices | `src/domain/` | `tests/domain/` |
| Use cases (the seam: rules + DB + payments) | `src/services/orders.ts` | `tests/integration/` (Docker) |
| Database access, schema | `src/db/` | `tests/integration/` (Docker) |
| Small helpers: status badges, formatting, redirects | `lib/` | `tests/lib/` |
| Fake payment provider | `src/payments/` | `tests/payments/` |
| MCP tools and API-key callers | `src/mcp/`, route in `app/api/mcp` | `tests/integration/mcp-*` (Docker) |
| Pages and admin UI | `app/` | `e2e/` (Playwright + Docker) |
| What the customer is told (the policy) | `help/*.md` | — |

`mcp/server.ts` is the local stdio MCP server (`npm run mcp:local`); the online one is the app route. They share `src/mcp/tools.ts`.
