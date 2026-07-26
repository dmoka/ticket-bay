// Adversarial lane — the refund time gate through the REAL server and the REAL
// /api/book + /api/refund endpoints. Nothing is mocked; only the clock is under
// test control (e2e/support/clock-server.ts).
//
// server/server.ts:80-88 already believes the rule. It releases seats only while
// `now < rec.order.eventStartMs`, and the comment above that line spells out the
// premise it is relying on:
//
//     "Once the event has started the customer keeps neither the money nor the
//      seat, so putting it back on sale would sell a paid-for seat to someone
//      else."
//
// The seat half of that sentence is implemented. The money half is not:
// `netRefund` at src/refund.ts:78 never compares `nowMs` to `order.eventStartMs`,
// so a post-event cancellation pays out in full. The venue therefore loses the
// money AND keeps the seat off sale — the worst of both branches.
//
// tests/server.test.ts drives this same harness but never moves the clock, and
// e2e/refund-seat-release.spec.ts has a `sellOutThenCancelAt(context, whenMs)`
// helper parameterised on the cancellation instant that is only ever called with
// `(start) => start - 1`. The post-event lane is built and unused.
//
// These tests are expected to FAIL against the current source.
import { describe, it, expect, afterEach } from "vitest";
import { startClockServer, ClockServer } from "../e2e/support/harness";

const TEST_TIMEOUT = 90_000;

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

describe("/api/refund pays nothing once the event has started", () => {
  // Each test gets a pristine venue on its own ports. Sharing one server across
  // tests leaks seat inventory between them, and a failure that comes from a
  // drifted fixture is not a finding.
  let nextPort = 4541;
  const running: ClockServer[] = [];

  afterEach(() => {
    while (running.length) running.pop()!.stop();
  });

  async function freshVenue() {
    const server = await startClockServer(nextPort++, nextPort++);
    running.push(server);
    return { server, http: api(server.url) };
  }

  it(
    "returns 0 cents for an order cancelled one millisecond after the show began",
    async () => {
      const { server, http } = await freshVenue();
      const booked = await http.book(2);
      expect(booked.ok).toBe(true);
      expect(booked.body.totalCents).toBe(10_000);

      await server.setClock(booked.body.eventStartMs + 1);
      const refunded = await http.refund(booked.body.id);

      expect(refunded.ok).toBe(true);
      // The customer sat through the show. Refunding 9800 cents hands back the
      // price of a ticket that was already consumed.
      expect(refunded.body.refundCents).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "returns 0 cents at exactly the event start, and the full amount one ms earlier",
    async () => {
      const { server, http } = await freshVenue();

      const late = await http.book(2);
      await server.setClock(late.body.eventStartMs);
      expect((await http.refund(late.body.id)).body.refundCents).toBe(0);

      await server.resetClock();
      const early = await http.book(2);
      await server.setClock(early.body.eventStartMs - 1);
      expect((await http.refund(early.body.id)).body.refundCents).toBe(9_800);
    },
    TEST_TIMEOUT,
  );

  it(
    "does not pay out AND withhold the seat — the venue cannot lose both",
    async () => {
      const { server, http } = await freshVenue();

      // Take the whole venue so inventory is directly observable: after a
      // post-event cancellation the seats must stay sold (server/server.ts:86
      // already does this), which is only defensible because no money moved.
      const booked = await http.book(60);
      expect(booked.ok, "fixture capacity changed — 100 seats less 40 sold").toBe(true);
      expect(booked.body.totalCents).toBe(270_000);
      expect((await http.book(1)).status).toBe(400); // sold out

      await server.setClock(booked.body.eventStartMs + 3_600_000);
      const refunded = await http.refund(booked.body.id);
      expect(refunded.ok).toBe(true);

      // Seats stay sold — this half is already correct.
      const stillSoldOut = await http.book(1);
      expect(stillSoldOut.status).toBe(400);
      expect(stillSoldOut.body.error).toContain("not enough seats");

      // ...so the money must stay put too. 264600 cents paid out on a seat the
      // venue also kept off sale is a straight double loss on one order.
      expect(refunded.body.refundCents).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
