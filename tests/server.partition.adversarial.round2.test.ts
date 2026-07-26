// Adversarial lane, round 2 — the two halves of one rule, checked against each
// other through the real server at the exact millisecond they disagree on.
//
// The refund window is implemented twice, in two files, by two different
// comparisons:
//
//   src/refund.ts:52      if (nowMs >= order.eventStartMs) return 0;
//   server/server.ts:89   if (now < rec.order.eventStartMs) { release seats }
//
// They are complements today. Nothing enforces that they stay complements, and
// the failure is silent in both directions: drift one way and the venue pays a
// refund AND keeps the seat off sale (a double loss on every order); drift the
// other way and it releases a seat to a new buyer while the original holder was
// paid nothing and still has a valid ticket (two people, one seat).
//
// tests/refund.round2.adversarial.test.ts checks this against a transcribed copy
// of the server predicate. That catches drift in src/refund.ts but not drift in
// server/server.ts, because the transcription would drift with it. This file
// asks the running server itself.
import { describe, it, expect, afterEach } from "vitest";
import { startClockServer, ClockServer } from "../e2e/support/harness";

const TEST_TIMEOUT = 90_000;

describe("money and seats flip at the same millisecond", () => {
  let nextPort = 4601;
  const running: ClockServer[] = [];

  afterEach(() => {
    while (running.length) running.pop()!.stop();
  });

  async function freshVenue() {
    const server = await startClockServer(nextPort++, nextPort++);
    running.push(server);
    const call = async (route: string, payload: unknown) => {
      const r = await fetch(`${server.url}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { ok: r.ok, status: r.status, body: await r.json() };
    };
    return { server, call };
  }

  /**
   * Sell out the venue, cancel the whole order at `eventStartMs + delta`, and
   * report both halves of the outcome: whether money moved, and whether the
   * seats went back on sale.
   */
  async function cancelAt(delta: number) {
    const { server, call } = await freshVenue();

    const booked = await call("/api/book", { tickets: 60 });
    expect(booked.ok, "fixture capacity changed — 100 seats less 40 sold").toBe(true);
    expect(booked.body.totalCents).toBe(270_000);
    expect((await call("/api/book", { tickets: 1 })).status, "expected a sold-out venue").toBe(400);

    await server.setClock(booked.body.eventStartMs + delta);
    const refunded = await call("/api/refund", { id: booked.body.id });
    expect(refunded.ok).toBe(true);

    // A booking that now succeeds proves the seats came back.
    const retry = await call("/api/book", { tickets: 1 });
    return { refundCents: refunded.body.refundCents as number, seatsReleased: retry.ok };
  }

  it(
    "one millisecond before the start: pays in full AND releases the seats",
    async () => {
      const { refundCents, seatsReleased } = await cancelAt(-1);
      expect(refundCents).toBe(264_600);
      expect(seatsReleased).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "at exactly the start: pays nothing AND keeps the seats sold",
    async () => {
      // The exact instant the whole rule turns on. Paying here while withholding
      // the seat costs the venue 264600 cents and 60 unsellable seats at once.
      const { refundCents, seatsReleased } = await cancelAt(0);
      expect(refundCents).toBe(0);
      expect(seatsReleased).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "one millisecond after the start: pays nothing AND keeps the seats sold",
    async () => {
      const { refundCents, seatsReleased } = await cancelAt(1);
      expect(refundCents).toBe(0);
      expect(seatsReleased).toBe(false);
    },
    TEST_TIMEOUT,
  );

  it(
    "money moving and seats returning are the same event, never one without the other",
    async () => {
      // The three instants either side of the boundary are covered above, each
      // on its own server. This widens the net to a day out in both directions.
      // Deliberately only two instants: every one of these boots a real server
      // process, and a test that spawns five of them under a parallel suite
      // fails on contention rather than on the defect.
      for (const delta of [-86_400_000, 86_400_000]) {
        const { refundCents, seatsReleased } = await cancelAt(delta);
        expect(refundCents > 0, `at eventStartMs${delta >= 0 ? "+" : ""}${delta}`).toBe(seatsReleased);
      }
    },
    TEST_TIMEOUT,
  );
});
