# The sandbox (a dev container)

A Docker container you work in, so an agent running with full permissions can only damage the box.
Based on [Anthropic's reference dev container](https://github.com/anthropics/claude-code/tree/main/.devcontainer).

**Open it:** VS Code or Cursor → "Reopen in Container". Or in a terminal: `npx @devcontainers/cli up --workspace-folder .`
**Inside:** `npm ci`, `npm run test:unit`, then `claude --dangerously-skip-permissions` (the container runs as the non-root `node` user, which that flag requires).

**What it does**
- The agent sees this repo and nothing else from your machine: no home folder, no `~/.ssh`, no Docker socket.
- Outgoing traffic is default-deny. Allowed: GitHub, the npm registry, and Claude's API and sign-in. Everything else is blocked (`init-firewall.sh`, checked on every start).
- The agent cannot change the firewall: its only root command is the firewall script itself.

**What it does not do**
- Anything inside the box can still leak: the repo, and any token you put in. Keep secrets out; use repo-scoped, short-lived tokens.
- Allowed hosts are a way out too (for example GitHub, if you log `gh` in), and DNS lookups still leave the box.
- The repo folder is shared with your machine, so the agent's edits land on your disk. Git is the undo button.
- Integration and UI tests need Docker (Testcontainers), and giving the box the Docker socket would give it your machine. Run `npm test` and `npm run test:ui` outside the box, or in CI.

Use it on repos you trust, and watch what the agent does.
