---
name: run-ticketbay
description: "Start TicketBay locally with its database and demo data. Use when the user says start TicketBay, run TicketBay, open TicketBay, run the app locally, start the dev server, set up the database or the demo data, or wants to log in and click through the storefront or /admin. Runs one script (Postgres, migrations, seed, dev server) on the host or in the box, then checks the storefront and gives the URLs and the demo logins. Not for tests, builds or deploys."
---

# Run TicketBay

Start the app from zero and hand the user a working storefront, admin dashboard and logins.

## Steps

1. **Start it.** Run `scripts/start.sh` from the repo root, in the background (it ends as the dev server and never exits). On the host it runs `npm run db:up`; in the box (`./box`, `DEVCONTAINER=true`) it uses the box's own Postgres and skips `db:up`. Then `npm ci` if `node_modules` is missing, `npm run db:migrate`, `npm run db:seed`, `npm run dev`. Done when its output shows `Ready` from Next.js.
2. **Port taken?** If the script stops on port 3000, run it again with `PORT=<free port>` (it sets `BETTER_AUTH_URL` to match). If it stops on Postgres, see Gotchas. In the box, the host port is `BOX_PORT`, not `PORT`. Done when the script reaches `Ready`.
3. **Check it.** `curl -s <Storefront URL>` lists the 8 demo events, e.g. `Midnight Arcade — Neon Tour`. Done when the page lists them.
4. **Report** the three lines the script printed:
   - Storefront: `http://localhost:3000/`
   - Admin: `http://localhost:3000/admin`
   - Logins: `anna@ticketbay.test` (customer, has orders under **My orders**), `admin@ticketbay.test` (admin, the `/admin` dashboard); password `ticketbay-demo` for both.

   Use the port the script printed. Done when the user has the URLs and both logins.

## Gotchas

- **Every run resets the demo data.** `db:seed` wipes events, orders and accounts first. To restart the server and keep the data, run `npm run dev` only.
- **Port 5432 taken on the host** (another Postgres; or `password authentication failed for user "ticketbay"` because another Postgres answers there): copy `.env.example` to `.env`, set `POSTGRES_PORT=5433` and the same port in `DATABASE_URL`, then run `scripts/start.sh` again.
- **Node 22 only** (`.nvmrc`). The script stops on another version: run `nvm use`.
- **The host needs a running Docker** for `db:up`. The box needs none: its database is the `db` container (`db:5432`), separate from the host one.
- **Login fails on another port**: `BETTER_AUTH_URL` must match the URL in the browser. The script sets it from `PORT` unless it is already set.
- **Stop the app** with Ctrl-C (or kill the background job). `npm run db:down` stops the host Postgres and keeps its data.

Last verified: 2026-10-08 with Claude Code 2.1.288
