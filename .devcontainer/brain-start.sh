#!/usr/bin/env bash
# Runs in the box at every start, after the firewall (postStartCommand), as the node user.
# Gives Claude Code in the box its own copy of your second brain (module 5): clones your brain
# repo into the box's brain volume the first time, pulls it on every later start, then runs the
# brain's install.sh (skills + pointer line in /home/node/.claude). The box shares nothing with
# your laptop's brain folder: it pushes with sync.sh, and your laptop gets that at its next pull.
# Never stops the box from starting: without a brain it says so in one line.
set -uo pipefail
brain=/home/node/brain

if [ -z "${BRAIN_REPO:-}" ] || [ -z "${BRAIN_GIT_TOKEN:-}" ]; then
  echo "brain: none in this box (set BRAIN_REPO and BRAIN_GIT_TOKEN in ~/.config/brain/box.env, see .devcontainer/README.md)"
  exit 0
fi

# The token comes from the environment for this command only: never in .git/config, never in ps output.
git=(git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$BRAIN_GIT_TOKEN"; }; f')
if [ ! -d "$brain/.git" ]; then
  if ! "${git[@]}" clone -q "$BRAIN_REPO" "$brain"; then
    echo "brain: could not clone $BRAIN_REPO (see above), so the box starts without a brain"
    exit 0
  fi
  echo "brain: cloned $BRAIN_REPO"
elif ! "${git[@]}" -C "$brain" pull -q --rebase --autostash; then
  echo "brain: could not pull (see above); the box uses the copy it has. Fix it in the box: cd $brain && git status"
fi
CLAUDE_DIR=/home/node/.claude bash "$brain/install.sh" || echo "brain: install.sh failed (see above)"
