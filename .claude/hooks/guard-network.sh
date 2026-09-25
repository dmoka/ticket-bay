#!/usr/bin/env bash
# PreToolUse guard for Bash, used by the unattended bug-triage loop.
# The loop reads customer email, which is untrusted. This hook is the layer
# that does not depend on the model obeying: it blocks the ways a hijacked
# agent could send data out or dump secrets. Exit 2 = block, stderr = reason.
cmd=$(jq -r '.tool_input.command // ""')

block() { echo "Blocked by guard-network: $1" >&2; exit 2; }

# 1. No environment dumps (the Discord webhook URL lives in the environment).
if grep -Eq '(^|[;&|( ]|\$\()(env|printenv|export -p|set)([ ;&|)]|$)|/proc/[^ ]*/environ' <<<"$cmd"; then
  block "commands that print the environment are not allowed"
fi

# 2. The webhook may appear only as the target of one curl post.
if grep -q 'DISCORD_WEBHOOK_URL' <<<"$cmd"; then
  n=$(grep -o 'DISCORD_WEBHOOK_URL' <<<"$cmd" | wc -l | tr -d ' ')
  grep -Eq '(^|[;&| ])curl ' <<<"$cmd" && [ "$n" = 1 ] \
    || block "DISCORD_WEBHOOK_URL may only be used as the target of one curl post"
fi

# 3. curl/wget/nc only to the webhook, never to a URL written out in the command.
if grep -Eq '(^|[;&|( ])(curl|wget|nc|ncat|telnet)( |$)' <<<"$cmd"; then
  grep -q 'DISCORD_WEBHOOK_URL' <<<"$cmd" || block "network tools may only post to \$DISCORD_WEBHOOK_URL"
  grep -Eq 'https?://' <<<"$cmd" && block "no literal URLs next to the webhook post"
fi

# 4. No literal URLs anywhere else, except git / gh / npm, which need GitHub and the registry.
if grep -Eq 'https?://' <<<"$cmd" && ! grep -Eq '^[[:space:]]*(git|gh|npm|npx) ' <<<"$cmd"; then
  block "commands with a literal URL are only allowed for git, gh and npm"
fi

exit 0
