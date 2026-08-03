// Seat inventory through the real server and the real endpoints. Only the clock
// is under test control (see e2e/support/clock-server.ts).
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
