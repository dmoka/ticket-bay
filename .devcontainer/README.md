# The sandbox (a dev container)

A Docker container you work in, so an agent running with full permissions can only damage the box.
Based on [Anthropic's reference dev container](https://github.com/anthropics/claude-code/tree/main/.devcontainer).

**Use it from the terminal:**

```bash
./box                      # start the box if needed, then Claude Code inside it
./box npm run test:unit    # run any command inside the box
./box bash                 # a shell inside the box
```

Inside, Claude Code runs with `--dangerously-skip-permissions`: the box is the safety, and it runs as the non-root `node` user, which that flag requires. First run: `./box npm ci`.
Prefer an editor? VS Code and Cursor open the same box with "Reopen in Container".

**What it does**
- The agent sees this repo and nothing else from your machine: no home folder, no `~/.ssh`, no Docker socket.
- Outgoing traffic is default-deny. Allowed: GitHub, the npm registry, and Claude's API and sign-in. Everything else is blocked (`init-firewall.sh`, checked on every start).
- The agent cannot change the firewall: its only root command is the firewall script itself.

**What it does not do**
- Anything inside the box can still leak: the repo, and any token you put in. Keep secrets out; use repo-scoped, short-lived tokens.
- Allowed hosts are a way out too (for example GitHub, if you log `gh` in), and DNS lookups still leave the box.
- The repo folder is shared with your machine, so the agent's edits land on your disk. Git is the undo button.
- Integration and UI tests need Docker (Testcontainers), and giving the box the Docker socket would give it your machine. They run in the CI gate (.github/workflows/gate.yml) on every pull request and every push to main; run `npm test` and `npm run test:ui` outside the box if you need them locally.

Use it on repos you trust, and watch what the agent does.

Last verified: 2026-09-29 with devcontainers CLI 0.89.0, Docker 28.0.1 and Claude Code 2.1.284
