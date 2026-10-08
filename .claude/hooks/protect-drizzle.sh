#!/usr/bin/env bash
# PreToolUse guard for Edit|Write|MultiEdit|Bash: nobody changes an existing migration in drizzle/.
# drizzle-kit writes those files from src/db/schema.ts; a hand edit makes the
# migration differ from the schema snapshot, and a database that already ran the
# old file never sees the change. Exit 2 = block, stderr = what to do instead.
input=$(cat)
case $(jq -r '.tool_name // empty' <<<"$input") in Read|Grep|Glob) exit 0 ;; esac   # reading drizzle/ is fine
path=$(jq -r '.tool_input.file_path // .tool_input.path // empty' <<<"$input")
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")

block() {
  echo "Blocked: $1 Never change an existing migration in drizzle/, by hand or with drizzle-kit drop, not even the latest one." \
       "Change src/db/schema.ts instead, then run: npm run db:generate (it writes a new migration and the drizzle/meta files)." >&2
  exit 2
}

# 1. The file tools: any path inside drizzle/ (drizzle.config.ts is not in it).
if [ -n "$path" ] && grep -Eq '(^|/)drizzle/' <<<"$path"; then
  block "$path is a migration file."
fi

[ -z "$cmd" ] && exit 0
# 2. drizzle-kit drop deletes the latest migration; a generate after it rewrites that migration.
grep -Eq 'drizzle-kit[^;&|]*[[:space:]]drop([^[:alnum:]_-]|$)' <<<"$cmd" && block "drizzle-kit drop deletes a migration."
# 3. The shell: a command that names drizzle/ and writes to it.
#    Redirects to /dev/null and fd copies (2>&1) are not writes: drop them first.
cmd=$(sed -E 's/[0-9]*&?>+[[:space:]]*\/dev\/null//g; s/[0-9]*>&[0-9]+//g' <<<"$cmd")
grep -Eq '(^|[^[:alnum:]_.-])drizzle/' <<<"$cmd" || exit 0   # npm run db:generate never names drizzle/
D='([^[:space:];&|"'"'"']*/)?drizzle/'                          # a path into drizzle/, relative or absolute
# Check each simple command on its own (split at ; & | and newlines).
while IFS= read -r seg; do
  grep -Eq "$D" <<<"$seg" || continue
  # > and >> into drizzle/
  grep -Eq ">[[:space:]]*[\"']?$D" <<<"$seg" && block "that command redirects output into drizzle/."
  # tee, sed -i, perl -i with a drizzle/ file
  grep -Eq "(^|[[:space:]])tee[[:space:]]" <<<"$seg" && block "that command writes into drizzle/ with tee."
  grep -Eq '(^|[[:space:]])(sed[[:space:]]+(-[a-zA-Z]*i|--in-place)|perl[[:space:]]+-[a-zA-Z]*i)' <<<"$seg" \
    && block "that command edits a drizzle/ file in place."
  # mv, rm, touch, truncate change drizzle/ wherever the path is (git mv / git rm too)
  grep -Eq '(^|[[:space:]])(mv|rm|touch|truncate)[[:space:]]' <<<"$seg" && block "that command changes files in drizzle/."
  # cp, install, ln, rsync write only to their last argument; dd writes to of=
  grep -Eq "(^|[[:space:]])(cp|install|ln|rsync)[[:space:]].*[[:space:]][\"']?$D[^[:space:]]*[\"']?[[:space:]]*\$" <<<"$seg" \
    && block "that command copies into drizzle/."
  grep -Eq "(^|[[:space:]])dd[[:space:]].*of=$D" <<<"$seg" && block "that command writes into drizzle/ with dd."
done < <(tr ';&|' '\n\n\n' <<<"$cmd")

exit 0
