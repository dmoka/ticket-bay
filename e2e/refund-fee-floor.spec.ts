// What the platform keeps, as the customer sees it.
//
// src/refund.ts states the fee rule on `refundFee`:
//   "Fee kept by the platform on every refund, in cents. Min 50, 2% of refund."
// and on `netRefund`: "Net amount returned to the customer. Never negative."
//
// At the default €50.00 ticket price no bookable quantity produces an order
// small enough for the 50-cent floor to bite, so these specs boot the real
// server with a cheaper `PRICE_CENTS` (an environment variable the server
// already reads — see server/server.ts). Nothing is stubbed: real page, real
// /api/book and /api/refund, real booking and refund modules.
import { test, expect, BrowserContext } from "@playwright/test";
import { startClockServer, ClockServer } from "./support/harness";
import { attemptBooking, bookingOutcome, bookThroughUI, cancelButton, collectDialogs, refundLine } from "./support/ui";

// Own port range so this file never fights the other harness-based specs.
let nextPort = 4500;
const running: ClockServer[] = [];

test.afterEach(() => {
  while (running.length) running.pop()!.stop();
});

async function cheapVenue(context: BrowserContext, priceCents: string) {
  const server = await startClockServer(nextPort++, nextPort++, { PRICE_CENTS: priceCents });
  running.push(server);
  const buyer = await context.newPage();
  await buyer.goto(server.url);
  return { server, buyer };
}

test("on a small order the customer is charged the 50-cent floor, not 2%", async ({ context }) => {
  const { buyer } = await cheapVenue(context, "1000");

  // 2 x €10.00, no group discount -> 2000 cents paid.
  const order = await bookThroughUI(buyer, "2");
  expect(order.totalCents, "PRICE_CENTS did not reach the server").toBe(2000);

  await cancelButton(buyer).click();
  // 2% of 2000 is 40, which is under the 50-cent minimum, so the fee is 50 and
  // the customer must be shown 1950 — a plain 2% would wrongly show 1960.
  await expect(refundLine(buyer), "the minimum fee must be applied, not the 2% rate").toHaveText(
    "Refunded: 1950 cents",
  );
});

test("a refund smaller than the fee shows zero back, never a negative amount", async ({ context }) => {
  const { buyer } = await cheapVenue(context, "10");

  // One ticket at 10 cents: the whole refund is under the 50-cent minimum fee.
  const order = await bookThroughUI(buyer, "1");
  expect(order.totalCents).toBe(10);

  await cancelButton(buyer).click();
  // The fee is capped at the refund, so the customer gets nothing back — and is
  // never shown a negative amount, which would read as money owed to us.
  await expect(refundLine(buyer), "net refund must be floored at zero, never negative").toHaveText(
    "Refunded: 0 cents",
  );
});

test("a cancellation entirely swallowed by the fee still puts the seat back on sale", async ({ context }) => {
  // server/server.ts gates the seat return on the CLOCK, not on the refund
  // amount, precisely so this case works: the customer got 0 cents back but
  // cancelled in time, so the seat is the venue's to sell again.
  const { server, buyer } = await cheapVenue(context, "10");

  // Fixture: 100 seats, 40 already sold. Take 59, then the last one.
  await bookThroughUI(buyer, "59");
  const lastSeatBuyer = await context.newPage();
  await lastSeatBuyer.goto(server.url);
  const lastSeat = await bookThroughUI(lastSeatBuyer, "1");
  expect(lastSeat.totalCents, "fixture capacity changed — update the seat counts").toBe(10);

  // Precondition: the page turns the next customer away.
  const latecomer = await context.newPage();
  const alerts = collectDialogs(latecomer);
  await latecomer.goto(server.url);
  await attemptBooking(latecomer, "1");
  await expect
    .poll(() => bookingOutcome(latecomer, alerts), { message: "expected the venue to be sold out before the cancel" })
    .toContain("not enough seats");

  // Cancel in time. The fee eats the entire refund.
  await cancelButton(lastSeatBuyer).click();
  await expect(refundLine(lastSeatBuyer)).toHaveText("Refunded: 0 cents");

  alerts.length = 0;
  await latecomer.reload();
  await attemptBooking(latecomer, "1");
  await expect
    .poll(() => bookingOutcome(latecomer, alerts), {
      message: "a zero-value refund is still a cancellation — that seat must go back on sale",
    })
    .toContain("Paid: 10 cents");
});
