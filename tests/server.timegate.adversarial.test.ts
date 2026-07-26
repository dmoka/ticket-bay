// Adversarial lane: the refund window through the REAL HTTP API.
//
// The unit lane (tests/refund.timegate.adversarial.test.ts) pins the rule on
// `calculateRefund` and `netRefund`. This file is the damage report: it drives
// the real server — real /api/book, real /api/refund, real booking and refund
// modules — and shows the money actually leaving the platform after the show has
// started. Only `Date.now()` is under test control (e2e/support/clock-server.ts),
// because the demo event always starts 30 days after boot.
//
// server/server.ts:97-102 states the paired rule in its own words:
//   "Seats come back only while refunds are still open. Once the event has
//    started the customer keeps neither the money nor the seat."
// The seat half of that sentence is enforced at server/server.ts:103
// (`if (now < rec.order.eventStartMs)`). The money half is not enforced anywhere:
// server/server.ts:93 calls `netRefund(..., now)` and pays whatever comes back.
//
// tests/server.test.ts already drives this same API and never moves the clock,
// so the whole after-showtime half of the endpoint is unexercised.
//
// This file spawns the clock server itself instead of using
// e2e/support/harness.ts. That harness now allocates its ports from Playwright's
// `test.info()`, which throws under vitest, so every vitest file that imports it
// fails at boot. Rather than hold a money-path check hostage to which runner the
// shared helper is currently written for, the ~40 lines below do the same job:
// spawn the REAL server (unmodified) with a frozen, steerable clock. Nothing is
// mocked here either — only "now" is under test control.
import { describe, it, expect, afterEach } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOOT_SEATS = 60; // totalSeats 100 - seatsSold 40
const BOOT_TIMEOUT = 90_000;
const DAY = 86_400_000;

interface ClockServer {
  url: string;
  setClock(ms: number): Promise<void>;
  stop(): void;
}

const running: ClockServer[] = [];

afterEach(() => {
  while (running.length) running.pop()!.stop();
});

/** A port the OS says is free right now, rather than a number picked by hand. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** Polls until the child answers, and gives up early if the child died. */
async function waitFor(url: string, child: ChildProcess, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`clock server exited with ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function startClockServer(): Promise<ClockServer> {
  const appPort = await freePort();
  const controlPort = await freePort();
  const child = spawn("npx", ["tsx", "e2e/support/clock-server.ts"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(appPort), CONTROL_PORT: String(controlPort) },
    detached: true,
    stdio: "ignore",
  });

  await waitFor(`http://localhost:${controlPort}/clock`, child);
  await waitFor(`http://localhost:${appPort}/`, child);

  return {
    url: `http://localhost:${appPort}`,
    async setClock(ms: number) {
      const r = await fetch(`http://localhost:${controlPort}/clock/set?ms=${ms}`, { method: "POST" });
      if (!r.ok) throw new Error(`setClock failed: ${r.status}`);
    },
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

const api = (base: string) => ({
  async book(tickets: number) {
    const r = await fetch(`${base}/api/book`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tickets }),
    });
    return { ok: r.ok, status: r.status, body: await r.json() };
  },
  async refund(id: number) {
    const r = await fetch(`${base}/api/refund`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    return { ok: r.ok, status: r.status, body: await r.json() };
  },
});

/** A pristine venue with its own clock, on its own port. */
async function freshVenue() {
  const server = await startClockServer();
  running.push(server);
  return { server, http: api(server.url) };
}

describe("refunds through the API close when the event starts", () => {
  it(
    "pays nothing when the customer cancels at the exact instant the show starts",
    async () => {
      const { server, http } = await freshVenue();
      const booked = await http.book(2);
      expect(booked.ok).toBe(true);
      expect(booked.body.totalCents).toBe(10_000); // 2 x 5000, no group tier

      // The closing instant itself. "From `eventStartMs` on" (src/refund.ts:17)
      // makes this reading already too late.
      await server.setClock(booked.body.eventStartMs);

      const refunded = await http.refund(booked.body.id);
      expect(refunded.ok).toBe(true);
      expect(refunded.body.refundCents).toBe(0);
    },
    BOOT_TIMEOUT,
  );

  it(
    "pays nothing to a sold-out house cancelling the morning after, and keeps the seats sold",
    async () => {
      const { server, http } = await freshVenue();
      const booked = await http.book(BOOT_SEATS);
      expect(booked.ok).toBe(true);
      expect(booked.body.totalCents).toBe(270_000); // 60 x 5000 less the 10% group tier
      expect((await http.book(1)).status).toBe(400); // sold out

      await server.setClock(booked.body.eventStartMs + DAY);
      const refunded = await http.refund(booked.body.id);
      expect(refunded.ok).toBe(true);

      // The seat half of the rule, which the server does enforce: the show has
      // happened, the seat does not go back on sale.
      expect((await http.book(1)).status).toBe(400);

      // The money half, which nothing enforces. €2,646 walks out of the till for
      // a show that already played to a full house.
      expect(refunded.body.refundCents).toBe(0);
    },
    BOOT_TIMEOUT,
  );

  it(
    "still pays in full, and releases the seats, when the customer cancels before the show",
    async () => {
      // The control. This passes today and must keep passing: a gate that closes
      // early would take 9,800 cents from a customer who cancelled in time.
      const { server, http } = await freshVenue();
      const booked = await http.book(BOOT_SEATS);
      expect(booked.ok).toBe(true);

      await server.setClock(booked.body.eventStartMs - 1);
      const refunded = await http.refund(booked.body.id);
      expect(refunded.ok).toBe(true);
      expect(refunded.body.refundCents).toBe(264_600); // 270000 less the 2% fee

      expect((await http.book(BOOT_SEATS)).ok).toBe(true); // every seat came back
    },
    BOOT_TIMEOUT,
  );
});
