// Test harness helpers — NOT application code.
//
// Boots the REAL server (server/server.ts, unmodified) on its own port with a
// frozen, steerable clock, so specs can drive the browser past the event start.
// See clock-server.ts for why this is needed. Nothing is mocked: the page and
// both API routes are the real thing, only "now" is under test control.
import { spawn, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface ClockServer {
  /** Base URL of the real booking UI. */
  url: string;
  /** Freeze the server's clock at an absolute instant. */
  setClock(ms: number): Promise<void>;
  /** Back to boot time — well before the event starts. */
  resetClock(): Promise<void>;
  stop(): void;
}

async function waitFor(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
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
 * `env` passes extra variables through to the real server — `PRICE_CENTS` is the
 * one specs need, to build an order small enough that the minimum refund fee
 * swallows it whole. The server already reads it; nothing is stubbed.
 */
export async function startClockServer(
  appPort: number,
  controlPort: number,
  env: Record<string, string> = {},
): Promise<ClockServer> {
  const control = `http://localhost:${controlPort}`;
  const child: ChildProcess = spawn("npx", ["tsx", "e2e/support/clock-server.ts"], {
    cwd: repoRoot,
    env: { ...process.env, ...env, PORT: String(appPort), CONTROL_PORT: String(controlPort) },
    detached: true,
    stdio: "ignore",
  });

  const post = async (route: string) => {
    const r = await fetch(`${control}${route}`, { method: "POST" });
    if (!r.ok) throw new Error(`${route} failed: ${r.status}`);
  };

  await waitFor(`${control}/clock`);
  await waitFor(`http://localhost:${appPort}/`);

  return {
    url: `http://localhost:${appPort}`,
    setClock: (ms) => post(`/clock/set?ms=${ms}`),
    resetClock: () => post("/clock/reset"),
    stop() {
      if (!child.pid) return;
      try {
        process.kill(-child.pid);
      } catch {
        child.kill("SIGKILL");
      }
    },
  };
}
