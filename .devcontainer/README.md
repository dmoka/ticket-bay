# The sandbox (a dev container)

A Docker container you work in, so an agent running with full permissions can only damage the box.
Based on [Anthropic's reference dev container](https://github.com/anthropics/claude-code/tree/main/.devcontainer).

**Use it from the terminal:**

```bash
./box                      # start the box if needed, then Claude Code inside it
./box npm run test:unit    # run any command inside the box
./box bash                 # a shell inside the box
./box --docker npm test    # the box on its own Docker engine: integration and UI tests run inside
```

Inside, Claude Code runs with `--dangerously-skip-permissions`: the box is the safety, and it runs as the non-root `node` user, which that flag requires. First run: `./box npm ci`.
Prefer an editor? VS Code and Cursor open the same box with "Reopen in Container".

**The app in the box.** The box is two containers (`compose.yaml`): `app`, where you and the agent work, and `db`, its own Postgres 17. `DATABASE_URL` points at `db:5432`, so `npm run db:migrate`, `npm run db:seed` and `npm run dev` work inside the box. Open http://localhost:3000 on your machine: port 3000 is published on 127.0.0.1 only. Port 3000 taken? Start the box with `BOX_PORT=3100 ./box` and open http://localhost:3100 (a running box keeps its port: to change it, run `docker compose -p <repo-folder>_devcontainer down`, e.g. `ticket-bay_devcontainer`, then `./box` again; the box database survives). The box database is separate from the one `npm run db:up` starts, and it is not published to your machine.

**Playwright MCP in the box.** The image has Playwright MCP 0.0.83's browser and Chromium's system libraries, both installed at build time. The firewall allows no browser downloads, so the version is pinned: `@latest` would ask for a newer browser the box cannot fetch. The box is Linux arm64 on Apple Silicon, where Playwright MCP's default Chrome channel does not exist, so add it with `--browser chromium`:

```bash
./box claude mcp add --scope project playwright -- npx @playwright/mcp@0.0.83 --browser chromium
```

**Docker in the box (`./box --docker`).** The integration tests, the UI tests and the integration-tester and ui-tester agents need Docker (Testcontainers). Your normal Docker engine cannot go into the box: Docker Desktop's VM shares your home folder, so `docker run -v ~/.ssh:/x` through its socket would read your keys. `./box --docker` runs the box on a separate engine instead: a [Colima](https://github.com/abiosoft/colima) VM (`ticketbay-box`) that shares only this repo with your machine. The box gets that VM's Docker socket, so every container it starts can see only what the VM sees: this repo, and nothing else from your machine.

One-time setup (macOS 13+; Docker Desktop's `docker` CLI is enough, the engine is not used):

```bash
brew install colima
./box --docker npm ci      # first run: starts the VM (4 CPUs, 4 GiB RAM), builds the box in it
./box --docker npm test    # unit + integration
./box --docker npm run test:ui
```

- `./box --docker` starts the VM when it is not running (about 30 s), refuses any VM that shares more than this repo (`docker/check-engine.sh`), and leaves your default Docker context and `~/.ssh/config` unchanged. Plain `./box` stays on your normal engine, without a socket.
- The Docker box is a separate box: its own image, `node_modules`, Claude Code sign-in and database, on the VM's disk. Port: the same `BOX_PORT` rule; the VM forwards it to 127.0.0.1 on your machine.
- The VM has its own firewall (`init-firewall.sh --engine`): every container on it reaches GitHub, npm, Claude's API and the other containers, nothing else (no internet, no ports on your machine). The box's own firewall is no longer the limit here: the socket can open a root shell in the box.
- Stop it: `colima stop ticketbay-box`. Remove it and its disk: `colima delete ticketbay-box`. Another clone of the repo: `BOX_DOCKER_PROFILE=<name> ./box --docker` (one VM per repo folder).
- VS Code and Cursor: "Reopen in Container" offers "TicketBay Sandbox + Docker (Colima)" (`docker/devcontainer.json`). Start the VM with `./box --docker true` and point the editor at the `colima-ticketbay-box` Docker context; on any other engine the box refuses to start. (Checked with the devcontainer CLI, not in an editor.)
- Linux (not tested): Colima runs there too, in a QEMU VM. Never mount your host's own Docker socket instead: on Linux that socket is root on your machine.

**No claude.ai connectors.** Signing in to Claude in the box would also bring your claude.ai connectors (Gmail, Drive, Calendar, ...) into Claude Code. The box turns them off (`ENABLE_CLAUDEAI_MCP_SERVERS=false` in `devcontainer.json`): the box limits what the agent can reach, and a connector would reach past the firewall.

**What it does**
- The agent sees this repo and nothing else from your machine: no home folder, no `~/.ssh`. Plain `./box` has no Docker socket; `./box --docker` has the socket of a VM that shares only this repo.
- Outgoing traffic is default-deny. Allowed: GitHub, the npm registry, Claude's API and sign-in, and the box's own Postgres (`db:5432`). Everything else is blocked (`init-firewall.sh`, checked on every start).
- The agent cannot change the firewall: its only root command is the firewall script itself (plain `./box`).

**What it does not do**
- Anything inside the box can still leak: the repo, and any token you put in. Keep secrets out; use repo-scoped, short-lived tokens.
- Allowed hosts are a way out too (for example GitHub, if you log `gh` in), and DNS lookups still leave the box.
- The repo folder is shared with your machine, so the agent's edits land on your disk. Git is the undo button.
- Integration and UI tests need Docker (Testcontainers). Plain `./box` has none: use `./box --docker`, or the CI gate (.github/workflows/gate.yml), which runs them on every pull request and every push to main.
- `./box --docker`: the socket makes the agent root in the VM. A container started with `--privileged` or `--network host` skips the VM's firewall and reaches the internet and the ports on your machine (`host.docker.internal`). Your files stay out of reach: the VM shares only this repo.

Use it on repos you trust, and watch what the agent does.

Last verified: 2026-10-04 with devcontainers CLI 0.89.0, Docker 28.0.1, Colima 0.10.3 (Docker 29.5.2 in the VM) and Claude Code 2.1.284
