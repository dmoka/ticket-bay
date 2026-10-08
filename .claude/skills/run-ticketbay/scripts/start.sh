#!/usr/bin/env bash
# start.sh — start TicketBay from zero: database, migrations, demo data, dev server.
# Usage: .claude/skills/run-ticketbay/scripts/start.sh   (from anywhere in the repo)
#   PORT=3100 start.sh   serve on another port on the host (BETTER_AUTH_URL follows it)
# Runs on the host (starts Postgres with docker compose) or in the box (./box: its own Postgres).
# Resets the demo data on every run, then keeps running as the dev server (stop it with Ctrl-C).
set -euo pipefail

case "${1:-}" in
  -h|--help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "start.sh takes no arguments (got: $1). Use PORT=<port> to change the port." >&2; exit 2 ;;
esac

cd "$(dirname "${BASH_SOURCE[0]}")/../../../.."   # the repo root
[ -f package.json ] && grep -q '"name": "ticketbay"' package.json \
  || { echo "start.sh: $(pwd) is not the TicketBay repo root" >&2; exit 1; }

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none)"
[ "$node_major" = "$(cat .nvmrc)" ] \
  || { echo "start.sh: needs Node $(cat .nvmrc) (found: $node_major). Run: nvm use" >&2; exit 1; }

if [ "${DEVCONTAINER:-}" = "true" ]; then
  echo "== in the box: using its own Postgres (db:5432), no db:up"
  port=3000                                  # the box publishes container port 3000; BOX_PORT picks the host port
  base_url="${BETTER_AUTH_URL:-http://localhost:3000}"
else
  echo "== on the host: starting Postgres (npm run db:up)"
  docker info >/dev/null 2>&1 \
    || { echo "start.sh: Docker is not running. Start Docker Desktop and run this again." >&2; exit 1; }
  npm run db:up || {
    echo "start.sh: Postgres did not start. Port 5432 taken? Put POSTGRES_PORT=5433 in .env" >&2
    echo "          and the same port in DATABASE_URL there (copy .env.example to .env first)." >&2
    exit 1
  }
  port="${PORT:-3000}"
  export BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://localhost:$port}"
  base_url="$BETTER_AUTH_URL"
fi
export PORT="$port"

node -e 'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.listen(+process.argv[1],()=>s.close(()=>process.exit(0)))' "$port" \
  || { echo "start.sh: port $port is taken. Run again with PORT=<free port> (in the box: BOX_PORT=<port> ./box)." >&2; exit 1; }

if [ -x node_modules/.bin/next ]; then
  echo "== dependencies already installed"
else
  echo "== installing dependencies (npm ci)"
  npm ci
fi

echo "== migrating the database (npm run db:migrate)"
npm run db:migrate
echo "== seeding the demo data (npm run db:seed)"
npm run db:seed

cat <<EOF

Storefront: $base_url/
Admin:      $base_url/admin
Logins:     anna@ticketbay.test (customer), admin@ticketbay.test (admin), password ticketbay-demo

== starting the dev server (npm run dev) on port $port
EOF
exec npm run dev
