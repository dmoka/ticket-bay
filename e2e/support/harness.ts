// Test harness helpers — NOT application code.
//
// Boots the REAL server (server/server.ts, unmodified) on its own port with a
// frozen, steerable clock, so specs can drive the browser past the event start.
// See clock-server.ts for why this is needed. Nothing is mocked: the page and
// both API routes are the real thing, only "now" is under test control.
//
// Used by BOTH runners: the Playwright specs in e2e/ and several vitest suites
// in tests/. That is why the explicit-port signature below still exists.
import { spawn, ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// Port allocation.
//
// Ports can be handed out HERE, per worker, instead of each spec file picking a
// base constant. Those constants were per-module, and a module is
// re-initialised in every worker process: run repeats of one file across
// workers (`--repeat-each` does exactly that) and two workers both started at
// the file's base and raced for the same port.
//
// Losing that race is not merely flaky. The loser dies with EADDRINUSE, and the
// readiness probe below would happily be satisfied by the WINNER — leaving a
// spec driving another test's server and asserting against its state. That is a
// test that passes while measuring the wrong process, which is worse than one
// that fails.
//
// The worker index separates workers; the running counter separates every
// server within one worker and is never reused, so nothing is rebound while a
// killed process is still in TIME_WAIT. Deriving both from the runner is what
// makes this safe by construction: there is no per-file base left to collide,
// and a new spec file cannot reintroduce one by picking an unlucky number.
//
// Read from the environment rather than `test.info()` so this module stays
// importable from vitest, which has no Playwright test context.
// `TEST_PARALLEL_INDEX` is the bounded one (0..workers-1). `TEST_WORKER_INDEX`
// climbs forever as workers are replaced and would eventually walk off the end
// of the port space.
// ---------------------------------------------------------------------------

/**
 * First port in the pool. Deliberately high and deliberately narrow, because it
 * has to clear two different kinds of neighbour:
 *   - what this repo pins itself: 4173 (the shared server in
 *     playwright.config.ts) and 4531/4532 (tests/server.test.ts, a vitest suite
 *     calling the explicit-port signature below);
 *   - whatever else happens to be running on a developer's machine. That is not
 *     hypothetical — while writing this, ports 5000, 5199, 6080 and 6463 were
 *     all taken by unrelated apps. The old per-file bases in the 4xxx range were
 *     one `npm run dev` away from a mystery failure.
 * A narrow lane keeps the whole pool clear of the common ones (7000, 8080).
 */
const POOL_BASE = 7300;
/** Ports reserved per worker. Each server takes two (app + clock control). */
const PORTS_PER_WORKER = 40;

let usedInWorker = 0;

function allocatePorts(): { appPort: number; controlPort: number } {
  const worker = Number(process.env.TEST_PARALLEL_INDEX ?? 0);
  const laneStart = POOL_BASE + (Number.isFinite(worker) ? worker : 0) * PORTS_PER_WORKER;
  const offset = usedInWorker;
  usedInWorker += 2;
  // Refuse to wrap into the next worker's lane. Running out is a loud error on
  // purpose: silently reusing a port is the exact failure this pool exists to
  // remove, and it would come back as a spec reading someone else's server.
  if (offset + 2 > PORTS_PER_WORKER) {
    throw new Error(
      `worker ${worker} exhausted its ${PORTS_PER_WORKER}-port lane after ${offset} ports — raise PORTS_PER_WORKER`,
    );
  }
  return { appPort: laneStart + offset, controlPort: laneStart + offset + 1 };
}

/** Whether nothing is listening on `port`. Binds the same way the server does. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port);
  });
}

/**
 * The lane above guarantees no two LIVE workers pick the same pair. It cannot
 * guarantee the pair is free, because a server leaked by an earlier run (or a
 * second copy of the suite running alongside this one) is still holding it.
 * Stepping over an occupied pair keeps the suite honest rather than red for a
 * reason that has nothing to do with the code under test.
 *
 * This is not a retry in the sense the suite forbids: it retries acquiring a
 * RESOURCE, never an assertion, and it cannot mask a product bug — the token
 * check still guarantees every spec talks to the server this harness started.
 * It warns each time it steps over one, so a leak stays visible instead of
 * being quietly absorbed.
 */
async function allocateFreePorts(): Promise<{ appPort: number; controlPort: number }> {
  for (;;) {
    const pair = allocatePorts();
    if ((await portIsFree(pair.appPort)) && (await portIsFree(pair.controlPort))) return pair;
    console.warn(
      `[harness] ports ${pair.appPort}/${pair.controlPort} are already in use — stepping over them. ` +
        `A clock server leaked by an earlier run is the usual cause: pkill -f clock-server.ts`,
    );
  }
}

// ---------------------------------------------------------------------------
// Teardown.
//
// `spawn` here is `npx -> tsx -> node`, three processes, and `detached: true`
// puts them in their own group so the whole chain can be killed at once. Two
// things about that had to be fixed, both observed leaking real servers:
//
//   - the signal. `process.kill(-pid)` defaults to SIGTERM, and npm's launcher
//     does not reliably pass it down; the npx wrapper exited while the node
//     process underneath kept the port. SIGKILL goes to every process in the
//     group directly, so there is no forwarding to rely on.
//   - the fallback. `child.kill()` signals only the group LEADER, so using it
//     when the group kill throws left the grandchildren running — the failure
//     it was supposed to cover was the one it made silent.
//
// A leaked server is not a tidiness problem: it holds a port, and the next run
// that reaches for that port fails for a reason that has nothing to do with the
// code under test.
// ---------------------------------------------------------------------------

/** Servers started by this worker and not yet stopped. */
const liveGroups = new Set<ChildProcess>();

function killGroup(child: ChildProcess) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* group already gone */
  }
}

// Last resort for the paths that never reach `stop()` — a worker torn down
// between the spawn and the afterEach. Detached children outlive their parent
// by design, so without this they outlive the test run too.
//
// `exit` only, deliberately. Adding a SIGINT listener SUPPRESSES Node's default
// terminate-on-Ctrl-C, so a handler here could leave a worker hanging on the
// keyboard interrupt it was meant to tidy up after. A worker that is SIGKILLed
// can therefore still leak; the liveness check in `waitFor` is what stops that
// leak from turning into a spec silently reading the wrong server later.
process.once("exit", () => {
  for (const child of liveGroups) killGroup(child);
  liveGroups.clear();
});

export interface ClockServer {
  /** Base URL of the real booking UI. */
  url: string;
  /** Freeze the server's clock at an absolute instant. */
  setClock(ms: number): Promise<void>;
  /** Back to boot time — well before the event starts. */
  resetClock(): Promise<void>;
  stop(): void;
}

/**
 * Polls `url` until it answers, and gives up the moment OUR child process dies.
 * Without the liveness check a dead child is indistinguishable from a slow one:
 * if something else is already listening, the fetch succeeds against that other
 * process and the caller proceeds against the wrong server. The allocator above
 * makes that unreachable for the Playwright specs — this makes it loud if it
 * ever happens anyway, including for the callers that still pin their own ports.
 */
async function waitFor(url: string, assertAlive: () => void, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    assertAlive();
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Proves the process answering on these ports is the child we just spawned.
 *
 * The readiness probe cannot tell the difference on its own. If a leaked server
 * from an earlier run still holds the ports, our child dies on EADDRINUSE while
 * the OLD one answers both probes — and it answers them immediately, so the
 * `exit` event has often not even fired yet. The test then runs against a venue
 * with someone else's seats already sold, and fails somewhere far away with a
 * booking that was refused for no visible reason. That was observed, not
 * theorised: it is what "expected Paid: visible, received hidden" turned out to
 * mean. A token the imposter cannot know settles it.
 */
async function assertServerIsOurs(control: string, token: string, appPort: number) {
  const seen = (await (await fetch(`${control}/clock`)).json()) as { token?: string };
  if (seen.token !== token) {
    throw new Error(
      `ports ${appPort}/${appPort + 1} are held by a DIFFERENT process than the one this test started — ` +
        `almost certainly a clock server leaked by an earlier run. Refusing to test against it, because its ` +
        `seat count and orders are not this test's. Kill the strays: pkill -f clock-server.ts`,
    );
  }
}

/**
 * Boots the real server on ports allocated for this worker.
 *
 * `env` passes extra variables through to the real server — `PRICE_CENTS` is the
 * one specs need, to build an order small enough that the minimum refund fee
 * swallows it whole. The server already reads it; nothing is stubbed.
 */
export function startClockServer(env?: Record<string, string>): Promise<ClockServer>;
/**
 * Boots the real server on ports the caller picks. For the vitest suites in
 * tests/, which run under a runner that sets no worker index.
 */
export function startClockServer(
  appPort: number,
  controlPort: number,
  env?: Record<string, string>,
): Promise<ClockServer>;
export async function startClockServer(
  portOrEnv?: number | Record<string, string>,
  maybeControlPort?: number,
  maybeEnv: Record<string, string> = {},
): Promise<ClockServer> {
  const pinned = typeof portOrEnv === "number";
  const { appPort, controlPort } = pinned
    ? { appPort: portOrEnv, controlPort: maybeControlPort as number }
    : await allocateFreePorts();
  const env = pinned ? maybeEnv : (portOrEnv ?? {});

  const control = `http://localhost:${controlPort}`;
  const token = randomUUID();
  const child: ChildProcess = spawn("npx", ["tsx", "e2e/support/clock-server.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      PORT: String(appPort),
      CONTROL_PORT: String(controlPort),
      INSTANCE_TOKEN: token,
    },
    detached: true,
    // stderr is captured rather than discarded so a boot failure reports WHY —
    // an EADDRINUSE reads very differently from a crash in the server itself.
    stdio: ["ignore", "ignore", "pipe"],
  });
  // Tracked from the instant it exists, not from the successful return below.
  // Everything between here and that return can throw, and a child orphaned by
  // a FAILED boot is the worst kind: it holds the very port the next run will
  // ask for, so one bad boot poisons every run after it.
  liveGroups.add(child);

  let stderr = "";
  child.stderr?.on("data", (c) => {
    stderr += c;
  });
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.on("exit", (code, signal) => {
    exit = { code, signal };
  });
  const assertAlive = () => {
    if (exit) {
      throw new Error(
        `clock server on port ${appPort} exited (code ${exit.code}, signal ${exit.signal}) ` +
          `before it was ready:\n${stderr.trim() || "<no stderr>"}`,
      );
    }
  };

  const post = async (route: string) => {
    const r = await fetch(`${control}${route}`, { method: "POST" });
    if (!r.ok) throw new Error(`${route} failed: ${r.status}`);
  };

  try {
    await waitFor(`${control}/clock`, assertAlive);
    await waitFor(`http://localhost:${appPort}/`, assertAlive);
    await assertServerIsOurs(control, token, appPort);
  } catch (e) {
    liveGroups.delete(child);
    killGroup(child);
    throw e;
  }

  return {
    url: `http://localhost:${appPort}`,
    setClock: (ms) => post(`/clock/set?ms=${ms}`),
    resetClock: () => post("/clock/reset"),
    stop() {
      liveGroups.delete(child);
      killGroup(child);
    },
  };
}
