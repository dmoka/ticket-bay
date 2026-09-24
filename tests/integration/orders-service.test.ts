// Booking and cancelling through the order services against real SQLite and
// the fake payment provider. Only the clock is under test control.
//
// Ported from the node:http server suites (server.test.ts,
// server.post-event-cutoff.adversarial.test.ts,
// server.refund-window.round2.adversarial.test.ts): the same venue (100 seats,
// 40 sold, €50.00), the same amounts, the same rules — asserted one layer
// below the UI instead of through an HTTP endpoint.
import { describe, it, expect } from "vitest";
import { getEvent } from "../../src/db/events-repo";
import { getCode } from "../../src/db/codes-repo";
import { getOrder } from "../../src/db/orders-repo";
import { OrderError } from "../../src/services/orders";
import { addCode, DAY, HOUR, NOW, shop, venue } from "./fixtures";

const SEATS_LEFT = 60;

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrderError);
    return (e as Error).message;
  }
  throw new Error("expected the booking to be refused");
}

describe("seats come back exactly once, never twice", () => {
  it("releases the exact number of seats the order held, and no more", async () => {
    const s = shop();
    const ev = venue(s.db);

    const { order } = await s.book(ev.id, SEATS_LEFT);
    expect(order.ticketsCents).toBe(270_000); // 60 x 5000 less the 10% group tier
    expect(await refused(s.book(ev.id, 1))).toMatch(/not enough seats/i);

    const r = await s.cancel(order.id);
    expect(r.refundCents).toBe(264_600); // 270000 less the 2% fee

    // A second refund is refused...
    expect(await refused(s.cancel(order.id))).toContain("already been refunded");
    // ...and must not have released the seats a second time.
    expect(await refused(s.book(ev.id, SEATS_LEFT + 1))).toContain("only 60 left");
    await s.book(ev.id, SEATS_LEFT);
    expect(await refused(s.book(ev.id, 1))).toMatch(/not enough seats/i);
  });
});

describe("a cancellation after the show has started pays nothing", () => {
  it("returns 0 cents when the customer cancels at the moment the doors open", async () => {
    const s = shop();
    const ev = venue(s.db);
    const { order } = await s.book(ev.id, 2);
    expect(order.ticketsCents).toBe(10_000);
    s.setClock(ev.startsAtMs);
    expect((await s.cancel(order.id)).refundCents).toBe(0);
  });

  it("returns 0 cents when the customer cancels a day after the show", async () => {
    const s = shop();
    const ev = venue(s.db);
    const { order } = await s.book(ev.id, 2);
    s.setClock(ev.startsAtMs + DAY);
    expect((await s.cancel(order.id)).refundCents).toBe(0);
  });

  it("still pays out in full one millisecond before the doors open", async () => {
    const s = shop();
    const ev = venue(s.db);
    const { order } = await s.book(ev.id, 2);
    s.setClock(ev.startsAtMs - 1);
    expect((await s.cancel(order.id)).refundCents).toBe(9_800);
  });

  it("pays a no-show nothing while also keeping their seat off the market", async () => {
    const s = shop();
    const ev = venue(s.db);
    const { order } = await s.book(ev.id, SEATS_LEFT);
    s.setClock(ev.startsAtMs + HOUR);
    const r = await s.cancel(order.id);
    expect(r.refundCents).toBe(0);
    expect(r.seatsReleased).toBe(false);
    expect(getEvent(s.db, ev.id)!.seatsSold).toBe(100);
  });
});

describe("the refund window, order by order", () => {
  it("pays the customer who cancelled in time and nothing to the one who did not, on the same venue", async () => {
    const s = shop();
    const ev = venue(s.db);
    const inTime = (await s.book(ev.id, 2)).order;
    const tooLate = (await s.book(ev.id, 2)).order;
    await s.book(ev.id, SEATS_LEFT - 4);

    s.setClock(ev.startsAtMs - 1);
    expect((await s.cancel(inTime.id)).refundCents).toBe(9_800);
    expect(getEvent(s.db, ev.id)!.seatsSold).toBe(98);

    s.setClock(ev.startsAtMs);
    expect((await s.cancel(tooLate.id)).refundCents).toBe(0);
    expect(getEvent(s.db, ev.id)!.seatsSold).toBe(98);
  });

  it("tells the two kinds of zero apart: a fee-swallowed refund frees the seat, a late one does not", async () => {
    const s = shop();
    const ev = venue(s.db, { priceCents: 25 });
    await s.book(ev.id, SEATS_LEFT - 1);
    const swallowed = (await s.book(ev.id, 1)).order;
    expect(swallowed.ticketsCents).toBe(25); // under the 50-cent refund-fee floor

    s.setClock(ev.startsAtMs - 1);
    const eaten = await s.cancel(swallowed.id);
    expect(eaten.refundCents).toBe(0);
    expect(eaten.seatsReleased).toBe(true);
    const resold = (await s.book(ev.id, 1)).order;

    s.setClock(ev.startsAtMs);
    const late = await s.cancel(resold.id);
    expect(late.refundCents).toBe(0);
    expect(late.seatsReleased).toBe(false);
    expect(getEvent(s.db, ev.id)!.seatsSold).toBe(100);
  });
});

describe("checkout", () => {
  it("charges the invoice total: tickets after discounts plus the service fee", async () => {
    const s = shop();
    const ev = venue(s.db);
    const { order } = await s.book(ev.id, 5);
    expect(order).toMatchObject({ subtotalCents: 25_000, discountPercent: 5, ticketsCents: 23_750, feeCents: 713, totalCents: 24_463 });
    expect(s.payments.getCharge(order.paymentId)?.amountCents).toBe(24_463);
  });

  it("applies the early-bird discount 30+ days out", async () => {
    const s = shop();
    const ev = venue(s.db, { startsAtMs: NOW + 40 * DAY });
    const { order } = await s.book(ev.id, 1);
    expect(order.earlyBirdPercent).toBe(10);
    expect(order.ticketsCents).toBe(4_500);
  });

  it("does not charge twice when the same checkout is submitted twice", async () => {
    const s = shop();
    const ev = venue(s.db);
    const first = await s.book(ev.id, 2, { idempotencyKey: "checkout-1" });
    const again = await s.book(ev.id, 2, { idempotencyKey: "checkout-1" });
    expect(again.replayed).toBe(true);
    expect(again.order.id).toBe(first.order.id);
    expect(getEvent(s.db, ev.id)!.seatsSold).toBe(42);
  });

  it("applies a discount code and counts its use", async () => {
    const s = shop();
    const ev = venue(s.db);
    addCode(s.db, "WELCOME10", 10);
    const { order } = await s.book(ev.id, 2, { code: " welcome10 " });
    expect(order).toMatchObject({ discountCode: "WELCOME10", codePercent: 10, ticketsCents: 9_000 });
    expect(getCode(s.db, "WELCOME10")!.uses).toBe(1);
  });

  it("refuses an unknown, expired or used-up code without charging", async () => {
    const s = shop();
    const ev = venue(s.db);
    addCode(s.db, "OLD", 25, { expiresAtMs: NOW });
    addCode(s.db, "ONCE", 50, { maxUses: 1, uses: 1 });
    expect(await refused(s.book(ev.id, 1, { code: "NOPE" }))).toBe("Unknown discount code.");
    expect(await refused(s.book(ev.id, 1, { code: "OLD" }))).toBe("This code has expired.");
    expect(await refused(s.book(ev.id, 1, { code: "ONCE" }))).toBe("This code has been fully redeemed.");
    expect(getEvent(s.db, ev.id)!.seatsSold).toBe(40);
  });

  it("closes sales at the event start", async () => {
    const s = shop();
    const ev = venue(s.db);
    s.setClock(ev.startsAtMs);
    expect(await refused(s.book(ev.id, 1))).toContain("already started");
  });

  it("refuses a booking bigger than the venue and charges nothing", async () => {
    const s = shop();
    const ev = venue(s.db);
    expect(await refused(s.book(ev.id, 999))).toMatch(/not enough seats/i);
    expect(getEvent(s.db, ev.id)!.seatsSold).toBe(40);
  });

  it("refuses a missing email or name", async () => {
    const s = shop();
    const ev = venue(s.db);
    expect(await refused(s.book(ev.id, 1, { email: "not-an-email" }))).toContain("valid email");
  });

  it("refunds the charge when the last seats go while the card is being charged", async () => {
    const s = shop();
    const ev = venue(s.db);
    // Two checkouts price the same last 60 seats; both get as far as the charge.
    const a = s.book(ev.id, SEATS_LEFT);
    const b = s.book(ev.id, SEATS_LEFT);
    const [ra, rb] = await Promise.allSettled([a, b]);
    const won = [ra, rb].filter((r) => r.status === "fulfilled");
    const lost = [ra, rb].filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(String(lost[0].reason)).toMatch(/not enough seats/i);
    expect(getEvent(s.db, ev.id)!.seatsSold).toBe(100);
  });

  it("cancels and records the provider refund id", async () => {
    const s = shop();
    const ev = venue(s.db);
    const { order } = await s.book(ev.id, 2);
    await s.cancel(order.id);
    const after = getOrder(s.db, order.id)!;
    expect(after.refundId).toMatch(/^re_/);
    expect(s.payments.getCharge(order.paymentId)?.refundedCents).toBe(9_800);
  });

  it("normalizes the customer's email so My orders finds the order", async () => {
    const s = shop();
    const ev = venue(s.db);
    const { order } = await s.book(ev.id, 1, { email: "  Fan@Example.COM " });
    expect(order.customerEmail).toBe("fan@example.com");
  });

  it("refuses an unknown event", async () => {
    const s = shop();
    expect(await refused(s.book("no-such-event", 1))).toBe("Event not found.");
  });

  it("does not let two checkouts share the last use of a limited code", async () => {
    const s = shop();
    const ev = venue(s.db);
    addCode(s.db, "LAST", 20, { maxUses: 1 });
    // Both price with the code while one use is left; only one may commit it.
    const results = await Promise.allSettled([s.book(ev.id, 1, { code: "LAST" }), s.book(ev.id, 1, { code: "LAST" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(lost.reason)).toContain("fully redeemed");
    expect(getCode(s.db, "LAST")!.uses).toBe(1);
    // The losing checkout's charge was given back in full.
    expect(getEvent(s.db, ev.id)!.seatsSold).toBe(41);
  });
});
