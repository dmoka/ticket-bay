// Adversarial lane, round 2 — the refund window driven through the REAL server.
//
// The gate landed in src/refund.ts. These two tests ask the questions a unit
// test cannot: does the shipped endpoint still pay a customer who cancelled in
// time, and does the money half of the rule still line up with the SEAT half
// (server/server.ts:103) now that both are gated on the same clock?
//
// Both tests measure inventory the only honest way available — the venue has no
// read endpoint, so a seat is "free" exactly when the next customer can buy it.
//
// Nothing is mocked: the real page, the real /api/book and /api/refund, the real
// booking and refund modules. Only `Date.now()` is under test control
// (e2e/support/clock-server.ts).
import { describe, it, expect, afterEach } from "vitest";
import { startClockServer, ClockServer } from "../e2e/support/harness";

const TEST_TIMEOUT = 90_000;
// Fixture capacity from server/server.ts: 100 seats, 40 already sold.
const SEATS_LEFT = 60;

describe("the refund window, order by order, through the shipped endpoint", () => {
  // Clear of 4531/4532 (server.test.ts), 4561+ (malformed-body), 4581+
  // (resilience), 4611+ (this lane's round-1 file) and the 7300 harness pool.
  let nextPort = 4651;
  const running: ClockServer[] = [];

  afterEach(() => {
    while (running.length) running.pop()!.stop();
  });

  async function freshVenue(env?: Record<string, string>) {
    const server = await startClockServer(nextPort++, nextPort++, env);
    running.push(server);
    const call = async (route: string, payload: unknown) => {
      const r = await fetch(`${server.url}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { ok: r.ok, status: r.status, body: (await r.json()) as Record<string, number & string> };
    };
    return {
      ...server,
      book: (tickets: number) => call("/api/book", { tickets }),
      refund: (id: number) => call("/api/refund", { id }),
    };
  }

  it(
    "pays the customer who cancelled in time and nothing to the one who did not, on the same venue",
    async () => {
      // A gate that leaked state between orders — or that read the clock once
      // per process instead of once per refund — would show up here and nowhere
      // else: two orders, identical in every way except which side of the event
      // start they were cancelled on.
      const venue = await freshVenue();

      const inTime = await venue.book(2);
      const tooLate = await venue.book(2);
      expect(inTime.body.totalCents).toBe(10_000); // 2 x €50.00, below the group tier
      expect(tooLate.body.totalCents).toBe(10_000);
      const start = inTime.body.eventStartMs;

      // Sell the rest of the house so inventory is measurable.
      expect((await venue.book(SEATS_LEFT - 4)).ok).toBe(true);
      expect((await venue.book(1)).status).toBe(400);

      // One millisecond before the doors open: paid in full, less the 2% fee.
      await venue.setClock(start - 1);
      const paid = await venue.refund(inTime.body.id);
      expect(paid.ok).toBe(true);
      expect(paid.body.refundCents).toBe(9_800);

      // ...and their two seats are back on sale, exactly two.
      expect((await venue.book(2)).ok).toBe(true);
      expect((await venue.book(1)).status).toBe(400);

      // The other customer waits until the doors open. Same order, same venue,
      // same process: nothing back, and no seat released.
      await venue.setClock(start);
      const refused = await venue.refund(tooLate.body.id);
      expect(refused.ok).toBe(true);
      expect(refused.body.refundCents).toBe(0);
      expect((await venue.book(1)).status).toBe(400);
    },
    TEST_TIMEOUT,
  );

  it(
    "tells the two kinds of zero apart: a fee-swallowed refund frees the seat, a late one does not",
    async () => {
      // Both customers are told "Refunded: 0 cents". One cancelled in time and
      // lost the lot to the 50-cent minimum fee; the other cancelled at the
      // instant the doors opened. The amounts are identical, so a seat-release
      // rule written against `refundCents > 0` instead of against the clock
      // would look right in every money assertion in the suite — and would keep
      // a seat off the market that the venue could still have sold.
      //
      // €0.25 tickets so a single-ticket order is smaller than the fee floor.
      const venue = await freshVenue({ PRICE_CENTS: "25" });

      expect((await venue.book(SEATS_LEFT - 1)).ok).toBe(true);
      const swallowed = await venue.book(1);
      expect(swallowed.body.totalCents).toBe(25); // under the 50-cent fee floor
      const start = swallowed.body.eventStartMs;
      expect((await venue.book(1)).status).toBe(400); // sold out

      // In time. The fee eats the whole 25 cents, so the customer sees zero...
      await venue.setClock(start - 1);
      const eaten = await venue.refund(swallowed.body.id);
      expect(eaten.ok).toBe(true);
      expect(eaten.body.refundCents).toBe(0);

      // ...but the seat is genuinely theirs to give back, and it is back.
      const resold = await venue.book(1);
      expect(resold.ok).toBe(true);
      expect(resold.body.totalCents).toBe(25);
      expect((await venue.book(1)).status).toBe(400); // sold out again

      // One millisecond later, the same order refunded at the start instant.
      // Same zero on the receipt, opposite answer on the seat.
      await venue.setClock(start);
      const late = await venue.refund(resold.body.id);
      expect(late.ok).toBe(true);
      expect(late.body.refundCents).toBe(0);

      const latecomer = await venue.book(1);
      expect(latecomer.status).toBe(400);
      expect(latecomer.body.error).toContain("not enough seats");
    },
    TEST_TIMEOUT,
  );
});
