#!/usr/bin/env bash
# Read-only look at one event or order in the local dev database (docker compose).
# Usage: scripts/db-peek.sh event <event-id> | scripts/db-peek.sh order <order-id>
set -uo pipefail
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
kind="${1:?usage: db-peek.sh event <id> | order <id>}"; id="${2:?missing id}"
cd "$root" || exit 2
# A stuck Docker daemon must fail fast, not hang: give the check 5 seconds.
running() {
  out="$(mktemp)"; docker compose ps --status running postgres >"$out" 2>/dev/null & pid=$!
  for _ in $(seq 1 50); do
    if ! kill -0 "$pid" 2>/dev/null; then grep -q postgres "$out"; rc=$?; rm -f "$out"; return $rc; fi
    sleep 0.1
  done
  pkill -9 -P "$pid" 2>/dev/null; kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; rm -f "$out"; return 1
}
if ! running; then
  echo "db-peek.sh: the dev database is not running (or Docker is not answering). Start it with: npm run db:up && npm run db:migrate && npm run db:seed" >&2
  exit 2
fi
case "$kind" in
  event) sql="select id, name, total_seats, seats_sold, total_seats - seats_sold as seats_left, to_timestamp(starts_at_ms/1000) as starts_at, cancelled_at_ms, price_cents from events where id = :'id';" ;;
  order) sql="select id, event_id, user_id, quantity, discount_percent, tickets_cents, total_cents, status, refund_cents, refund_fee_cents from orders where id = :'id'::int;" ;;
  *) echo "db-peek.sh: kind must be 'event' or 'order'" >&2; exit 2 ;;
esac
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -x -v id="$1"' _ "$id" <<SQL
set default_transaction_read_only = on;
$sql
SQL
