// Adversarial lane, round 2 — attacking the fix for the round-1 crash.
//
// Round 1 found `JSON.parse` sitting above the `try` in an async handler, where
// nothing catches its rejection. The fix moved the parse inside the try
// (server/server.ts:61-65). That half is genuinely fixed: unparseable bodies,
// 10MB bodies and multi-chunk bodies all return 400 now and the process lives.
//
// But the line ABOVE the parse did not move:
//
//     server/server.ts:59-60
//         let body = "";
//         for await (const chunk of req) body += chunk;
//     server/server.ts:61
//         try {
//
// `for await (const chunk of req)` is itself an await on a stream that can
// reject. When a client disconnects mid-body, Node's IncomingMessage aborts and
// the async iterator throws `Error: aborted` (code ECONNRESET) — outside the
// try, in an async handler, with no catch anywhere above it. The process exits
// exactly as it did in round 1.
//
// This is a strictly worse trigger than the round-1 one. An unparseable body
// takes a client that sends bad bytes on purpose. A connection that drops
// mid-upload is what a phone leaving a tunnel, a closed browser tab, or a load
// balancer idle-timeout does BY ACCIDENT, many times a day.
//
// These tests are expected to FAIL against the current source.
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { startClockServer, ClockServer } from "../e2e/support/harness";

const TEST_TIMEOUT = 90_000;

describe("a client that vanishes mid-request does not take the server with it", () => {
  let nextPort = 4581;
  const running: ClockServer[] = [];

  afterEach(() => {
    while (running.length) running.pop()!.stop();
  });

  async function freshVenue() {
    const server = await startClockServer(nextPort++, nextPort++);
    running.push(server);
    return server;
  }

  const port = (server: ClockServer) => Number(new URL(server.url).port);

  /**
   * Announce `declared` bytes of body, send `partial`, then hard-destroy the
   * socket. This is a dropped connection, not a malformed request: the bytes
   * that did arrive are perfectly good JSON so far.
   */
  function abortMidBody(appPort: number, route: string, partial: string, declared: number): Promise<void> {
    return new Promise((resolve) => {
      const s = net.connect(appPort, "localhost", () => {
        s.write(
          `POST ${route} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${declared}\r\n\r\n`,
        );
        s.write(partial);
        setTimeout(() => {
          s.destroy();
          resolve();
        }, 250);
      });
      s.on("error", () => resolve());
    });
  }

  const post = async (base: string, route: string, body: unknown) => {
    const r = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  it(
    "survives a connection dropped mid-body on /api/refund, and keeps the order refundable",
    async () => {
      const server = await freshVenue();

      const booked = await post(server.url, "/api/book", { tickets: 2 });
      expect(booked.status).toBe(200);
      const id = booked.body.id;

      // A customer's phone loses signal while the cancel request is uploading.
      await abortMidBody(port(server), "/api/refund", '{"id":1,"pa', 200);
      await new Promise((r) => setTimeout(r, 500));

      // The order that customer already paid for must still exist and still be
      // refundable. If the process died, the booking died with it: `orders` is
      // an in-memory Map (server/server.ts:21) and the restart resets
      // `event.seatsSold` to its boot value.
      const refunded = await post(server.url, "/api/refund", { id });
      expect(refunded.status).toBe(200);
      expect(refunded.body.refundCents).toBe(9_800);
    },
    TEST_TIMEOUT,
  );

  it(
    "survives a connection dropped mid-body on /api/book",
    async () => {
      const server = await freshVenue();

      await abortMidBody(port(server), "/api/book", '{"tick', 100);
      await new Promise((r) => setTimeout(r, 500));

      const booked = await post(server.url, "/api/book", { tickets: 2 });
      expect(booked.status).toBe(200);
      expect(booked.body.totalCents).toBe(10_000);
    },
    TEST_TIMEOUT,
  );

  it(
    "survives a client that announces a body and sends none of it",
    async () => {
      const server = await freshVenue();

      await abortMidBody(port(server), "/api/book", "", 50);
      await new Promise((r) => setTimeout(r, 500));

      const booked = await post(server.url, "/api/book", { tickets: 1 });
      expect(booked.status).toBe(200);
    },
    TEST_TIMEOUT,
  );
});
