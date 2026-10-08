# TicketBay

TicketBay is a ticket shop for concerts, comedy nights and conferences. It is a Next.js app with a Postgres database.

## Getting started

- Install dependencies with `npm install`.
- Start the database with `npm run db:up`, and stop it with `npm run db:down`.
- Apply the migrations with `npm run db:migrate`.
- Load the demo data with `npm run db:seed`.
- Start the app with `npm run dev`. It runs on http://localhost:3000.
- Build for production with `npm run build`, then `npm run start`.
- Check the types with `npm run typecheck`.
- Start the local MCP server with `npm run mcp:local`.

## Tests

- `npm test` runs every Vitest test (unit + integration).
- `npm run test:unit` runs the unit tests (no Docker).
- `npm run test:domain` runs only the domain tests.
- `npm run test:integration` runs the integration tests against Postgres.
- `npm run test:http` runs the REST API tests.
- `npm run test:ui` runs the Playwright tests.
- `npm run test:mutation` runs Stryker on `src/domain`.
- The refund tests live in `tests/domain` (`refund*.test.ts`).

## Architecture

- The UI is in `app/`, built with the Next.js App Router.
- Public pages are in `app/(public)`, the admin pages in `app/admin`.
- API routes are in `app/api`.
- Business rules live in `src/domain`: `booking.ts`, `cancellation.ts`, `fees.ts`, `invoice.ts`, `pricing.ts`, `refund.ts`.
- Use cases live in `src/services`, for example `src/services/orders.ts`.
- Database access lives in `src/db`. Each table has its own repo file, for example `events-repo.ts` and `orders-repo.ts`.
- The database schema is in `src/db/schema.ts`.
- Payments go through `src/payments`.
- Authentication is in `src/auth` and `lib/auth.ts`.
- The MCP server is in `src/mcp`.
- Small helpers live in `lib/`, for example `lib/format.ts` and `lib/status.ts`.
- Checkout lives in the checkout folder under events.
- Tests import app code with relative paths, for example `../../src/domain/refund`.
- We use Tailwind for styling.
- We use Drizzle as the ORM.

## Code style

- Use TypeScript everywhere.
- Use two spaces for indentation.
- Prefer named exports.
- Write small functions.
- Write clean code.

## Rules

- Money is always integer cents, never floats.
- Never push to `main`. Every change goes through a pull request, and the six CI checks must pass.
- Never edit the migrations in the `drizzle/` folder by hand. Change the schema, then run `npm run db:generate`.
- Test behavior through the public API: the route handlers and the `src/domain` / `src/services` functions the app calls. Never test private helpers, never assert on internal calls, never mock `src/domain` or `src/services`. The HTTP and integration tests mock only the wiring seams `lib/auth`, `src/db/client` and `src/payments`; their pass-through vi.mock calls for `src/auth` and `src/mcp` re-import the real module.
- Never mark a mutant equivalent yourself. When the CI mutation check finds a survivor, write a test that kills it. If you think it cannot be killed, stop and ask the human, with the reason.
- A regression test goes in a new file `tests/domain/regression-<short-slug>.test.ts` (code in `src/domain`) or `tests/lib/regression-<short-slug>.test.ts` (code in `lib/`). Do not edit the unit test config.

## Notes

- The demo customer is `anna@ticketbay.test`.
- The admin user is `admin@ticketbay.test`.
- Docker is needed for the integration and UI tests.
- If the database is in a bad state, run `docker compose down -v`, then `npm run db:up`, `npm run db:migrate` and `npm run db:seed`.
