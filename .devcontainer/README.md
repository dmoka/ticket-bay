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

**The brain in the box (module 5).** The box keeps its own copy of your second brain, in its own volume (`/home/node/brain`), cloned from your brain repo. It never mounts the brain folder on your laptop. Every time the box starts, `brain-start.sh` clones the brain the first time and pulls it after that, then runs the brain's `install.sh` with `CLAUDE_DIR=/home/node/.claude`, so Claude Code in the box gets the brain's skills and the pointer line. Your laptop's `~/.claude` is not touched. In the box, `./sync.sh` (in `/home/node/brain`) commits and pushes with the box's own deploy key; your laptop gets the box's changes at its next pull.

🙋 **Give the box its deploy key (once):**
1. Make a key pair just for the box, with no passphrase, and name your brain repo:
   ```bash
   mkdir -p ~/.config/brain && chmod 700 ~/.config/brain
   ssh-keygen -t ed25519 -N "" -C "brain box" -f ~/.config/brain/box_deploy_key
   echo 'BRAIN_REPO=git@github.com:<you>/brain.git' > ~/.config/brain/box.env
   ```
2. GitHub → your brain repo → Settings → **Deploy keys** → **Add deploy key**. Paste `~/.config/brain/box_deploy_key.pub`, tick **Allow write access**, add it. GitHub accepts that key for this one repo only.
3. The box reads the folder when it is created. If it is running, run `docker compose -p <repo-folder>_devcontainer down` (e.g. `ticket-bay_devcontainer`), then `./box`. The brain volume survives `down`.

- The box mounts `~/.config/brain` read-only at `/home/node/.config/brain` (another folder: `BOX_BRAIN_CONFIG=/path ./box`). The key is used per command (`brain-start.sh`, the brain's `sync.sh`, through `GIT_SSH_COMMAND` and `BRAIN_SSH_KEY`), never in a git config.
- No `box.env` or no key: the box starts as before, without a brain, and its start log says so in one line. A clone or pull that fails never stops the box either.
- `./box --docker` is a separate box with its own brain volume. Its Colima VM also shares `~/.config/brain`, read-only. A VM from before the brain shares only the repo, and `check-engine.sh` refuses it: stop it (`colima stop ticketbay-box`) and run `./box --docker` again.

**Docker in the box (`./box --docker`).** The integration tests, the UI tests and the integration-tester and ui-tester agents need Docker (Testcontainers). Your normal Docker engine cannot go into the box: Docker Desktop's VM shares your home folder, so `docker run -v ~/.ssh:/x` through its socket would read your keys. `./box --docker` runs the box on a separate engine instead: a [Colima](https://github.com/abiosoft/colima) VM (`ticketbay-box`) that shares only this repo with your machine. The box gets that VM's Docker socket, so every container it starts can see only what the VM sees: this repo, and nothing else from your machine.

One-time setup (macOS 13+; Docker Desktop's `docker` CLI is enough, the engine is not used):

```bash
brew install colima
./box --docker npm ci      # first run: starts the VM (4 CPUs, 4 GiB RAM), builds the box in it
./box --docker npm test    # unit + integration
./box --docker npm run test:ui
```

- `./box --docker` starts the VM when it is not running (about 30 s), refuses any VM that shares more than this repo and the brain settings folder (`docker/check-engine.sh`), and leaves your default Docker context and `~/.ssh/config` unchanged. Plain `./box` stays on your normal engine, without a socket.
- The Docker box is a separate box: its own image, `node_modules`, Claude Code sign-in and database, on the VM's disk. Port: the same `BOX_PORT` rule; the VM forwards it to 127.0.0.1 on your machine.
- The VM has its own firewall (`init-firewall.sh --engine`). The box keeps its allowlist (GitHub, npm, Claude). Every other container reaches only the other containers: no internet, no npm, no ports on your machine (`host.docker.internal`). Testcontainers needs no more: the engine pulls its images.
- Stop it: `colima stop ticketbay-box`. Remove it and its disk: `colima delete --data ticketbay-box`. Another clone of the repo: `BOX_DOCKER_PROFILE=<name> ./box --docker` (one VM per repo folder).
- VS Code and Cursor: "Reopen in Container" offers "TicketBay Sandbox + Docker (Colima)" (`docker/devcontainer.json`). Start the VM with `./box --docker true` and point the editor at the `colima-ticketbay-box` Docker context; on any other engine the box refuses to start. (Checked with the devcontainer CLI, not in an editor.)
- Linux (not tested): Colima runs there too, in a QEMU VM. Never mount your host's own Docker socket instead: on Linux that socket is root on your machine.

**What `--docker` does not protect**
- The socket makes the agent root in the VM. It can open a root shell in the box (`docker exec -u 0`) and remove the box's own firewall; the VM's firewall then still limits the box to the allowlist.
- A container started with `--privileged` or `--network host` skips the VM's firewall: it reaches the internet and the ports on your machine (`host.docker.internal`), and it can remove the VM's firewall.
- A container that shares the box's network (`--network container:<box>`) has the box's allowlist.
- What stays out of reach in every case: your files. The VM shares only this repo, so no container sees your home folder, `~/.ssh` or Docker Desktop's socket.
- Proposed follow-up: a Docker authorization plugin in the VM that refuses privileged containers, host namespaces, extra capabilities, binds outside the repo and host-network builds.

**No claude.ai connectors.** Signing in to Claude in the box would also bring your claude.ai connectors (Gmail, Drive, Calendar, ...) into Claude Code. The box turns them off (`ENABLE_CLAUDEAI_MCP_SERVERS=false` in `devcontainer.json`): the box limits what the agent can reach, and a connector would reach past the firewall.

**What it does**
- The agent sees this repo, and `~/.config/brain` read-only, and nothing else from your machine: no other home folder files, no `~/.ssh`. Plain `./box` has no Docker socket; `./box --docker` has the socket of a VM that shares only this repo.
- Outgoing traffic is default-deny. Allowed: GitHub, the npm registry, Claude's API and sign-in, and the box's own Postgres (`db:5432`). Everything else is blocked (`init-firewall.sh`, checked on every start).
- The agent cannot change the firewall: its only root command is the firewall script itself (plain `./box`).

**What it does not do**
- Anything inside the box can still leak: the repo, the box's copy of your brain, and any token you put in. Keep secrets out; use repo-scoped, short-lived tokens.
- The brain's deploy key is readable in the box: anything in the box can read it, and read and write the brain repo with it (and nothing else). What the box pushes to the brain, every agent that pulls the brain reads next, including agents on your laptop. Read the brain's `git log -p` for changes to `skills/` and its scripts (`sync.sh`, `install.sh`) before you run them on your laptop.
- Allowed hosts are a way out too (for example GitHub, if you log `gh` in, or with any token the agent is given), and DNS lookups still leave the box. GitHub's ranges are allowed on every port, so SSH to GitHub works too (the brain's deploy key uses it).
- The repo folder is shared with your machine, so the agent's edits land on your disk. Git is the undo button.
- Plain `./box` has no Docker socket (it would give the box your machine), so Testcontainers cannot run there. The Postgres tests fall back to the box's own database instead: `./box npm run test:http` (or `test:integration`, or `npm test`) creates throwaway databases next to the app's on `db:5432` and drops them at the end. UI tests (Playwright) need Docker: use `./box --docker`, or the CI gate (.github/workflows/gate.yml), which runs them on every pull request and every push to main.
- `./box --docker` is weaker on the network: see "What `--docker` does not protect" above.

Use it on repos you trust, and watch what the agent does.

Last verified: 2026-10-04 with devcontainers CLI 0.89.0, Docker 28.0.1, Colima 0.10.3 (Docker 29.5.2 in the VM) and Claude Code 2.1.284
