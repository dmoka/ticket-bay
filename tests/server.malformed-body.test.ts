// Adversarial lane — what a malformed request body does to the booking server.
//
// server/server.ts wraps both endpoints in a try/catch (server/server.ts:62 and
// :91) whose whole purpose is to turn a bad request into a 400 with a readable
// error. But the parse that is most likely to fail on untrusted input —
// `JSON.parse(body || "{}")` at server/server.ts:61 — sits ONE LINE ABOVE the
// `try`. In an `async` request handler that rejection is never caught by
// anything, so Node tears the process down on it.
//
// The blast radius is not one request. `orders` (server/server.ts:21) and
// `event.seatsSold` (server/server.ts:13-20) are in-memory: the crash takes
// every live booking with it, and a restart silently resets inventory back to
// its boot value. Every existing server-level test (tests/server.test.ts,
// e2e/*.spec.ts) sends well-formed JSON through a `JSON.stringify` helper, so
// this line is never exercised with anything a real client could send.
//
// These tests are expected to FAIL against the current source.
import { describe, it, expect, afterEach } from "vitest";
import { startClockServer, ClockServer } from "../e2e/support/harness";

const TEST_TIMEOUT = 90_000;

describe("a malformed request body is a 400, not a dead server", () => {
  let nextPort = 4561;
  const running: ClockServer[] = [];

  afterEach(() => {
    while (running.length) running.pop()!.stop();
  });

  async function freshVenue() {
    const server = await startClockServer(nextPort++, nextPort++);
    running.push(server);
    return server;
  }

  const postRaw = async (base: string, route: string, body: string) => {
    const r = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return { status: r.status, text: await r.text() };
  };

  it(
    "rejects unparseable JSON on /api/refund and keeps serving",
    async () => {
      const server = await freshVenue();

      // A real order exists before the bad request, so the assertion below is
      // about losing live state, not just about losing a process.
      const booked = await postRaw(server.url, "/api/book", JSON.stringify({ tickets: 2 }));
      expect(booked.status).toBe(200);
      const id = JSON.parse(booked.text).id;

      const bad = await postRaw(server.url, "/api/refund", "{");
      expect(bad.status).toBe(400);

      // The order that existed before the bad request must still be refundable.
      // If the process died, this booking record went with it and the customer's
      // paid-for order no longer exists to refund.
      const refunded = await postRaw(server.url, "/api/refund", JSON.stringify({ id }));
      expect(refunded.status).toBe(200);
      expect(JSON.parse(refunded.text).refundCents).toBe(9_800);
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects unparseable JSON on /api/book and keeps serving",
    async () => {
      const server = await freshVenue();

      const bad = await postRaw(server.url, "/api/book", "not json at all");
      expect(bad.status).toBe(400);

      const booked = await postRaw(server.url, "/api/book", JSON.stringify({ tickets: 2 }));
      expect(booked.status).toBe(200);
      expect(JSON.parse(booked.text).totalCents).toBe(10_000);
    },
    TEST_TIMEOUT,
  );

  it(
    "survives a body that parses to something that is not an object",
    async () => {
      const server = await freshVenue();

      // Valid JSON, wrong shape. `data.tickets` / `data.id` on a primitive is
      // `undefined`, which the domain validators are expected to refuse.
      for (const body of ["null", "42", '"two"', "[1,2]"]) {
        expect((await postRaw(server.url, "/api/book", body)).status, `body ${body}`).toBe(400);
        expect((await postRaw(server.url, "/api/refund", body)).status, `body ${body}`).toBe(400);
      }

      const booked = await postRaw(server.url, "/api/book", JSON.stringify({ tickets: 1 }));
      expect(booked.status).toBe(200);
    },
    TEST_TIMEOUT,
  );
});
