// Adversarial lane, round 3, job 2 — attacks on the conditional seat release in
// server/server.ts. The real server, the real endpoints, only the clock is under
// test control (see e2e/support/clock-server.ts).
//
// Inventory has no read endpoint, so seats are measured the only honest way
// available: drive the event to sold out, then a booking that succeeds proves a
// seat came back and a booking that fails proves it did not.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startClockServer, ClockServer } from "../e2e/support/harness";

const BOOT_SEATS = 60; // totalSeats 100 - seatsSold 40
const BOOT_TIMEOUT = 90_000;

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

describe("seats come back exactly once, never twice", () => {
  let server: ClockServer;
  let http: ReturnType<typeof api>;

  beforeAll(async () => {
    server = await startClockServer(4531, 4532);
    http = api(server.url);
  }, BOOT_TIMEOUT);

  afterAll(() => server?.stop());

  it("releases the exact number of seats the order held, and no more", async () => {
    const booked = await http.book(BOOT_SEATS);
    expect(booked.ok).toBe(true);
    expect(booked.body.tickets).toBe(BOOT_SEATS);
    expect(booked.body.totalCents).toBe(270_000); // 60 x 5000 less the 10% group tier

    // Sold out.
    expect((await http.book(1)).status).toBe(400);

    const refunded = await http.refund(booked.body.id);
    expect(refunded.ok).toBe(true);
    expect(refunded.body.refundCents).toBe(264_600); // 270000 less the 2% fee

    // A second refund is refused...
    const second = await http.refund(booked.body.id);
    expect(second.status).toBe(400);
    expect(second.body.error).toContain("already refunded");

    // ...and, critically, it must not have released the seats a second time.
    // A double release drives seatsSold to -20 and puts 120 seats on sale for a
    // 100-seat room: 20 people pay for a seat that does not physically exist.
    const oversell = await http.book(BOOT_SEATS + 1);
    expect(oversell.status).toBe(400);
    expect(oversell.body.error).toContain("not enough seats");

    // Exactly the 60 seats came back — not 59, not 120.
    expect((await http.book(BOOT_SEATS)).ok).toBe(true);
    expect((await http.book(1)).status).toBe(400);
  });
});

describe("the clock partitions refund and seat release at the same instant", () => {
  let server: ClockServer;
  let http: ReturnType<typeof api>;
  let eventStart: number;
  // Threaded between the tests below, which run as one sequential narrative on
  // a single server. Never hardcode order ids — they shift the moment a test is
  // added above.
  let bulkId: number;
  let strandedId: number;

  beforeAll(async () => {
    server = await startClockServer(4541, 4542);
    http = api(server.url);
    const probe = await http.book(1);
    eventStart = probe.body.eventStartMs;
    // Hand that probe seat straight back so the room starts full again.
    await http.refund(probe.body.id);
  }, BOOT_TIMEOUT);

  afterAll(() => server?.stop());

  it("pays out and releases the seat one tick before the event starts", async () => {
    const bulk = await http.book(BOOT_SEATS - 1); // 59, leaving one seat
    const last = await http.book(1);
    expect(bulk.ok && last.ok).toBe(true);
    bulkId = bulk.body.id;
    expect((await http.book(1)).status).toBe(400); // sold out

    await server.setClock(eventStart - 1);
    const r = await http.refund(last.body.id);
    expect(r.ok).toBe(true);
    expect(r.body.refundCents).toBe(4_900); // 5000 less the 100-cent minimum fee

    // Money moved, so the seat must be back on sale.
    expect((await http.book(1)).ok).toBe(true);
  });

  it("pays nothing and strands the seat at the exact start instant", async () => {
    // The room is sold out again from the previous test's re-booking.
    expect((await http.book(1)).status).toBe(400);

    await server.setClock(eventStart - 1);
    expect((await http.refund(bulkId)).ok).toBe(true);
    const held = await http.book(BOOT_SEATS - 1);
    expect(held.ok).toBe(true);
    strandedId = held.body.id;
    expect((await http.book(1)).status).toBe(400); // sold out again

    await server.setClock(eventStart);
    const r = await http.refund(strandedId);
    expect(r.ok).toBe(true);
    expect(r.body.refundCents).toBe(0); // the refund gate is shut

    // No money moved, so the seat stays with the customer. Releasing it here
    // would resell a seat that someone has already paid for and can still use.
    expect((await http.book(1)).status).toBe(400);
  });

  it("refuses to hand back the seats of a spent order when the clock is rewound", async () => {
    // The sharpest version of the attack: cancel after the event so nothing is
    // released, then wind the clock back to before the event and cancel again.
    // If the already-refunded guard sat below the clock check, the second call
    // would release seats for an order that was already settled.
    await server.setClock(eventStart + 1);
    const spent = await http.refund(strandedId);
    expect(spent.status).toBe(400);
    expect(spent.body.error).toContain("already refunded");

    await server.setClock(eventStart - 1);
    const rewound = await http.refund(strandedId);
    expect(rewound.status).toBe(400);
    expect(rewound.body.error).toContain("already refunded");

    // Still sold out — the rewind bought nothing.
    expect((await http.book(1)).status).toBe(400);
  });

  it("refuses an unknown order at every point on the clock", async () => {
    for (const t of [eventStart - 1, eventStart, eventStart + 1]) {
      await server.setClock(t);
      const r = await http.refund(9_999);
      expect(r.status).toBe(400);
      expect(r.body.error).toContain("no such order");
    }
  });
});

describe("a pre-event refund of zero is a real case, so releasing on refundCents would strand seats", () => {
  // The server gates seat release on the clock, not on `refundCents > 0`. This
  // pins why that distinction matters, at the layer where it is observable:
  // netRefund returns 0 for two entirely different reasons.
  it("returns zero before the event when the minimum fee swallows the refund", async () => {
    const { calculateRefund, netRefund } = await import("../src/refund");
    const tiny = { totalCents: 50, tickets: 1, discountPercent: 0, eventStartMs: 1_700_000_000_000 };
    expect(calculateRefund(tiny, 1, tiny.eventStartMs - 1)).toBe(50); // refunds are open
    expect(netRefund(tiny, 1, tiny.eventStartMs - 1)).toBe(0); // fee eats all of it
    expect(netRefund(tiny, 1, tiny.eventStartMs)).toBe(0); // gate shut, same number
    // Same 0, opposite meaning: the first seat belongs back in inventory, the
    // second does not. Only the clock tells them apart.
  });
});
