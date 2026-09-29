#!/usr/bin/env bash
# Run one regression test with the fast unit config (no Docker) and say RED or GREEN.
# Usage: scripts/repro.sh tests/lib/regression-<slug>.test.ts
set -uo pipefail
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
file="${1:?usage: repro.sh <test file under tests/domain, tests/lib or tests/payments>}"
case "$file" in
  tests/domain/*|tests/lib/*|tests/payments/*) ;;
  *) echo "repro.sh: $file is outside the unit folders (tests/domain, tests/lib, tests/payments); the unit config will not find it." >&2; exit 2 ;;
esac
cd "$root" || exit 2
[ -d node_modules ] || { echo "repro.sh: run 'npm ci' first." >&2; exit 2; }
if npx vitest run --config vitest.unit.config.ts "$file"; then
  echo "GREEN: $file passes — it does not reproduce the report yet."
else
  echo "RED: $file fails — check it fails for the reported reason, not on an import."
  exit 1
fi
