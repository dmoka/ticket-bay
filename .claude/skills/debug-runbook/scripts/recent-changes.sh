#!/usr/bin/env bash
# Recent commits that touched an area, newest first, with the files they changed.
# Usage: scripts/recent-changes.sh [path ...]   (default: src lib app)
set -uo pipefail
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$root" || exit 2
[ $# -gt 0 ] || set -- src lib app
git log --since="30 days ago" -n 15 --date=short --format='%h %ad %s' --name-only -- "$@"
