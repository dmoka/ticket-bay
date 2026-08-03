// Adversarial lane — the refund cut-off, driven through the REAL server.
//
// The unit-level case is in refund.post-event-cutoff.adversarial.test.ts. This
// file answers the "so what" question: does the missing cut-off actually move
// money out of the platform through the shipped endpoint, or is it a detail
// that never reaches a customer?
//
// server/server.ts calls `netRefund(rec.order, rec.order.tickets, now)` with the
// real clock (server.ts:93) and hands the result straight back as `refundCents`,
// which the page renders as "Refunded: N cents". The server states the intended
// outcome in its own comment two lines further down (server.ts:97-99):
//
//   "Once the event has started the customer keeps neither the money nor the
//    seat, so putting it back on sale would sell a paid-for seat to someone
//    else."
//
// The seat half of that sentence is implemented — `if (now < eventStartMs)`
// guards the release. The money half is not, because `netRefund` never looks at
// the clock it is handed.
//
// Only the clock is under test control (e2e/support/clock-server.ts); the page,
// both routes and the booking/refund modules are the real thing.
import { describe, it, expect, afterEach } from "vitest";
import { startClockServer, ClockServer } from "../e2e/support/harness";

const TEST_TIMEOUT = 90_000;
// Fixture capacity from server/server.ts: 100 seats, 40 already sold.
const SEATS_LEFT = 60;

describe("a cancellation after the show has started pays nothing", () => {
  // Clear of 4531/4532 (server.test.ts), 4561+ (malformed-body) and 4581+
  // (resilience), and clear of the 7300 harness pool.
  let nextPort = 4611;
  const running: ClockServer[] = [];

  afterEach(() => {
    while (running.length) running.pop()!.stop();
  });

  async function freshVenue() {
    const server = await startClockServer(nextPort++, nextPort++);
    running.push(server);
    return {
      ...server,
      async book(tickets: number) {
        const r = await fetch(`${server.url}/api/book`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tickets }),
        });
        return { ok: r.ok, status: r.status, body: await r.json() };
      },
      async refund(id: number) {
        const r = await fetch(`${server.url}/api/refund`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
        return { ok: r.ok, status: r.status, body: await r.json() };
      },
    };
  }

  it(
    "returns 0 cents when the customer cancels at the moment the doors open",
    async () => {
      const venue = await freshVenue();

      const booked = await venue.book(2);
      expect(booked.ok).toBe(true);
      expect(booked.body.totalCents).toBe(10_000); // 2 x €50.00, no group tier

      await venue.setClock(booked.body.eventStartMs);

      const refunded = await venue.refund(booked.body.id);
      expect(refunded.ok).toBe(true);
      expect(refunded.body.refundCents).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "returns 0 cents when the customer cancels a day after the show",
    async () => {
      const venue = await freshVenue();

      const booked = await venue.book(2);
      expect(booked.ok).toBe(true);

      await venue.setClock(booked.body.eventStartMs + 24 * 3_600_000);

      const refunded = await venue.refund(booked.body.id);
      expect(refunded.ok).toBe(true);
      expect(refunded.body.refundCents).toBe(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "still pays out in full one millisecond before the doors open",
    async () => {
      // The open side through the same endpoint: the cut-off must not close
      // early and strand a customer who cancelled in time.
      const venue = await freshVenue();

      const booked = await venue.book(2);
      await venue.setClock(booked.body.eventStartMs - 1);

      const refunded = await venue.refund(booked.body.id);
      expect(refunded.ok).toBe(true);
      expect(refunded.body.refundCents).toBe(9_800); // 10000 less the 2% fee
    },
    TEST_TIMEOUT,
  );

  it(
    "pays a no-show nothing while also keeping their seat off the market",
    async () => {
      // The two halves of server.ts:97-99 asserted together. Inventory has no
      // read endpoint, so the seat is measured the honest way: sell the venue
      // out, cancel late, and see whether the next customer can buy in.
      const venue = await freshVenue();

      const booked = await venue.book(SEATS_LEFT);
      expect(booked.ok).toBe(true);
      expect(booked.body.totalCents).toBe(270_000); // 60 x €50.00 less the 10% group tier

      // Sold out.
      expect((await venue.book(1)).status).toBe(400);

      await venue.setClock(booked.body.eventStartMs + 3_600_000);
      const refunded = await venue.refund(booked.body.id);
      expect(refunded.ok).toBe(true);

      // Neither the money...
      expect(refunded.body.refundCents).toBe(0);

      // ...nor the seat. Releasing it would resell a seat that was already used.
      const latecomer = await venue.book(1);
      expect(latecomer.status).toBe(400);
      expect(latecomer.body.error).toContain("not enough seats");
    },
    TEST_TIMEOUT,
  );
});
