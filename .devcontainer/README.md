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

**The brain in the box (module 5).** The box mounts your second brain, `~/brain` on your machine, at `/home/node/brain`, read and write. No brain yet? The box creates an empty `~/brain` and starts without one. Another folder: `BOX_BRAIN=/path/to/brain ./box`. A running box keeps its mount: to change it, run `docker compose -p <repo-folder>_devcontainer down`, then `./box` again. Every time the box starts, it runs the brain's `install.sh` with `CLAUDE_DIR=/home/node/.claude`, so Claude Code in the box gets the brain's skills and the pointer line, in the box's own config volume. Your machine's `~/.claude` is not touched.

- **The box pushes the brain itself**, with its own token: a GitHub fine-grained token that can write only your brain repo (Contents: read and write, nothing else). 🙋 Create it (the brain template's README, "In a dev container"), and save it in a file outside this repo and outside the brain:
  ```bash
  mkdir -p ~/.config/brain && printf 'BRAIN_GIT_TOKEN=%s\n' 'github_pat_…' > ~/.config/brain/box.env && chmod 600 ~/.config/brain/box.env
  ```
  The box reads that file when it is created: if it is running, run `docker compose -p <repo-folder>_devcontainer down`, then `./box`. Without the file, `./sync.sh` in the box commits the brain, says it did not push, and exits 1; `./sync.sh` on your machine pushes it. `sync.sh` uses the token for that one push and never writes it to the brain's `.git/config`, which your machine shares.
- Git trusts the mounted folder: the image sets `safe.directory=/home/node/brain` in the box's own system git config, never in the brain.
- `./box --docker`: the Colima VM shares this repo and the brain folder, at the same paths. A VM from before the brain shares only the repo, and `check-engine.sh` refuses it: stop it (`colima stop ticketbay-box`) and run `./box --docker` again.

**Docker in the box (`./box --docker`).** The integration tests, the UI tests and the integration-tester and ui-tester agents need Docker (Testcontainers). Your normal Docker engine cannot go into the box: Docker Desktop's VM shares your home folder, so `docker run -v ~/.ssh:/x` through its socket would read your keys. `./box --docker` runs the box on a separate engine instead: a [Colima](https://github.com/abiosoft/colima) VM (`ticketbay-box`) that shares only this repo and your brain folder with your machine. The box gets that VM's Docker socket, so every container it starts can see only what the VM sees: this repo, the brain, and nothing else from your machine.

One-time setup (macOS 13+; Docker Desktop's `docker` CLI is enough, the engine is not used):

```bash
brew install colima
./box --docker npm ci      # first run: starts the VM (4 CPUs, 4 GiB RAM), builds the box in it
./box --docker npm test    # unit + integration
./box --docker npm run test:ui
```

- `./box --docker` starts the VM when it is not running (about 30 s), refuses any VM that shares more than this repo and the brain folder (`docker/check-engine.sh`), and leaves your default Docker context and `~/.ssh/config` unchanged. Plain `./box` stays on your normal engine, without a socket.
- The Docker box is a separate box: its own image, `node_modules`, Claude Code sign-in and database, on the VM's disk. Port: the same `BOX_PORT` rule; the VM forwards it to 127.0.0.1 on your machine.
- The VM has its own firewall (`init-firewall.sh --engine`). The box keeps its allowlist (GitHub, npm, Claude). Every other container reaches only the other containers: no internet, no npm, no ports on your machine (`host.docker.internal`). Testcontainers needs no more: the engine pulls its images.
- Stop it: `colima stop ticketbay-box`. Remove it and its disk: `colima delete --data ticketbay-box`. Another clone of the repo: `BOX_DOCKER_PROFILE=<name> ./box --docker` (one VM per repo folder).
- VS Code and Cursor: "Reopen in Container" offers "TicketBay Sandbox + Docker (Colima)" (`docker/devcontainer.json`). Start the VM with `./box --docker true` and point the editor at the `colima-ticketbay-box` Docker context; on any other engine the box refuses to start. (Checked with the devcontainer CLI, not in an editor.)
- Linux (not tested): Colima runs there too, in a QEMU VM. Never mount your host's own Docker socket instead: on Linux that socket is root on your machine.

**What `--docker` does not protect**
- The socket makes the agent root in the VM. It can open a root shell in the box (`docker exec -u 0`) and remove the box's own firewall; the VM's firewall then still limits the box to the allowlist.
- A container started with `--privileged` or `--network host` skips the VM's firewall: it reaches the internet and the ports on your machine (`host.docker.internal`), and it can remove the VM's firewall.
- A container that shares the box's network (`--network container:<box>`) has the box's allowlist.
- What stays out of reach in every case: your other files. The VM shares only this repo and the brain folder, so no container sees the rest of your home folder, `~/.ssh` or Docker Desktop's socket.
- Proposed follow-up: a Docker authorization plugin in the VM that refuses privileged containers, host namespaces, extra capabilities, binds outside the repo and host-network builds.

**No claude.ai connectors.** Signing in to Claude in the box would also bring your claude.ai connectors (Gmail, Drive, Calendar, ...) into Claude Code. The box turns them off (`ENABLE_CLAUDEAI_MCP_SERVERS=false` in `devcontainer.json`): the box limits what the agent can reach, and a connector would reach past the firewall.

**What it does**
- The agent sees this repo and your brain folder (`~/brain`), and nothing else from your machine: no other home folder files, no `~/.ssh`. Plain `./box` has no Docker socket; `./box --docker` has the socket of a VM that shares only this repo and the brain.
- Outgoing traffic is default-deny. Allowed: GitHub, the npm registry, Claude's API and sign-in, and the box's own Postgres (`db:5432`). Everything else is blocked (`init-firewall.sh`, checked on every start).
- The agent cannot change the firewall: its only root command is the firewall script itself (plain `./box`).

**What it does not do**
- Anything inside the box can still leak: the repo, and any token you put in. Keep secrets out; use repo-scoped, short-lived tokens.
- Allowed hosts are a way out too (for example GitHub, if you log `gh` in), and DNS lookups still leave the box.
- The repo folder is shared with your machine, so the agent's edits land on your disk. Git is the undo button.
- The brain is shared both ways. The agent reads every note in it, and what it writes lands in `~/brain` on your machine, including the brain's skills and scripts (`sync.sh`, `install.sh`), which agents on your machine run outside the box, and the brain's `.git` folder: a git hook written there runs on your machine at your next `git commit` in the brain. Check that `~/brain/.git/hooks` holds only `*.sample` files, and read the brain's `git log -p` for changes to `skills/` and the scripts.
- The brain token is in the box's environment: anything in the box can read it and push to the brain repo (and to nothing else). Give it a short expiry.
- Plain `./box` has no Docker socket (it would give the box your machine), so Testcontainers cannot run there. The Postgres tests fall back to the box's own database instead: `./box npm run test:http` (or `test:integration`, or `npm test`) creates throwaway databases next to the app's on `db:5432` and drops them at the end. UI tests (Playwright) need Docker: use `./box --docker`, or the CI gate (.github/workflows/gate.yml), which runs them on every pull request and every push to main.
- `./box --docker` is weaker on the network: see "What `--docker` does not protect" above.

Use it on repos you trust, and watch what the agent does.

Last verified: 2026-10-04 with devcontainers CLI 0.89.0, Docker 28.0.1, Colima 0.10.3 (Docker 29.5.2 in the VM) and Claude Code 2.1.284
