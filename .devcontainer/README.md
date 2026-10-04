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

**The app in the box.** The box is two containers (`compose.yaml`): `app`, where you and the agent work, and `db`, its own Postgres 17. `DATABASE_URL` points at `db:5432`, so `npm run db:migrate`, `npm run db:seed` and `npm run dev` work inside the box. Open http://localhost:3000 on your machine: port 3000 is published on 127.0.0.1 only. Port 3000 taken? Start the box with `BOX_PORT=3100 ./box` and open http://localhost:3100 (a running box keeps its port: to change it, run `docker compose -p <repo-folder>_devcontainer down`, e.g. `ticket-bay_devcontainer`, then `./box` again; the box database survives). The box database is separate from the one `npm run db:up` starts, and it is not published to your machine.

**What it does**
- The agent sees this repo and nothing else from your machine: no home folder, no `~/.ssh`, no Docker socket.
- Outgoing traffic is default-deny. Allowed: GitHub, the npm registry, Claude's API and sign-in, and the box's own Postgres (`db:5432`). Everything else is blocked (`init-firewall.sh`, checked on every start).
- The agent cannot change the firewall: its only root command is the firewall script itself.

**What it does not do**
- Anything inside the box can still leak: the repo, and any token you put in. Keep secrets out; use repo-scoped, short-lived tokens.
- Allowed hosts are a way out too (for example GitHub, if you log `gh` in), and DNS lookups still leave the box.
- The repo folder is shared with your machine, so the agent's edits land on your disk. Git is the undo button.
- Integration and UI tests need Docker (Testcontainers), and giving the box the Docker socket would give it your machine. They run in the CI gate (.github/workflows/gate.yml) on every pull request and every push to main; run `npm test` and `npm run test:ui` outside the box if you need them locally.

Use it on repos you trust, and watch what the agent does.

Last verified: 2026-09-29 with devcontainers CLI 0.89.0, Docker 28.0.1 and Claude Code 2.1.284
