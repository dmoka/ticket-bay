#!/usr/bin/env bash
# PreToolUse guard for Bash, used by the unattended bug-triage loop.
# The loop reads customer email, which is untrusted. This hook is the layer
# that does not depend on the model obeying: it blocks the ways a hijacked
# agent could send data out or dump secrets. Exit 2 = block, stderr = reason.
cmd=$(jq -r '.tool_input.command // ""')

block() { echo "Blocked by guard-network: $1" >&2; exit 2; }

# True when the command has at least one literal URL and every URL points at this
# machine (localhost, 127.0.0.1, [::1], 0.0.0.0). Local traffic never leaves the
# machine, so it is not a way out. Userinfo tricks (http://localhost@evil.com) are
# handled: the host is what comes after the last "@" before the path.
only_local_urls() {
  local urls url rest host
  urls=$(grep -Eo 'https?://[^[:space:]"'"'"'<>]+' <<<"$cmd") || return 1
  while IFS= read -r url; do
    rest=${url#*://}; rest=${rest%%/*}; rest=${rest%%\?*}; rest=${rest%%#*}
    host=${rest##*@}
    case "$host" in
      localhost|localhost:*|127.0.0.1|127.0.0.1:*|0.0.0.0|0.0.0.0:*|\[::1\]|\[::1\]:*) ;;
      *) return 1 ;;
    esac
  done <<<"$urls"
  return 0
}

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

# 3. curl/wget/nc only to the webhook, never to a URL written out in the command —
#    except URLs on this machine (a local dev server, the M6 MCP route).
if grep -Eq '(^|[;&|( ])(curl|wget|nc|ncat|telnet)( |$)' <<<"$cmd" && ! only_local_urls; then
  grep -q 'DISCORD_WEBHOOK_URL' <<<"$cmd" || block "network tools may only post to \$DISCORD_WEBHOOK_URL"
  grep -Eq 'https?://' <<<"$cmd" && block "no literal URLs next to the webhook post"
fi

# 4. No literal URLs anywhere else, except git / gh / npm (GitHub and the registry)
#    and URLs on this machine.
if grep -Eq 'https?://' <<<"$cmd" && ! grep -Eq '^[[:space:]]*(git|gh|npm|npx) ' <<<"$cmd" && ! only_local_urls; then
  block "commands with a literal URL are only allowed for git, gh and npm"
fi

exit 0
