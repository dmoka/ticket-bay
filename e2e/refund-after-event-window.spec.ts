// The refund WINDOW, as the customer experiences it.
//
// src/refund.ts states the rule on `calculateRefund`:
//   "Business rule: cancellations are only allowed BEFORE the event starts.
//    From `eventStartMs` on, the refund is zero."
//
// Every other UI spec cancels while the window is open, so the closing edge is
// unreached from a browser: the demo event always starts 30 days after boot.
// These specs drive the real server's clock (support/clock-server.ts) across
// that edge and assert the AMOUNT the page puts in front of the customer on
// each side of it. Nothing is mocked — real page, real /api/book and
// /api/refund, real booking and refund modules; only "now" is under test
// control.
//
// Own server per test (support/harness.ts) like the rest of the suite: the
// venue lives in module-level state, so a shared one makes an exact-cents
// assertion meaningless.
import { test, expect, BrowserContext } from "@playwright/test";
import { startClockServer, ClockServer } from "./support/harness";
import { attemptBooking, bookingOutcome, bookThroughUI, cancelButton, collectDialogs, refundLine } from "./support/ui";

// Fixture capacity from server/server.ts: 100 seats, 40 already sold, €50.00 each.
const SEATS_LEFT = "60";
// 60 x €50.00 less the 10% group discount.
const SOLD_OUT_TOTAL = 270000;

const running: ClockServer[] = [];

test.afterEach(() => {
  while (running.length) running.pop()!.stop();
});

/** A freshly booted venue and a page already on it. */
async function freshVenue(context: BrowserContext) {
  const server = await startClockServer();
  running.push(server);
  const page = await context.newPage();
  await page.goto(server.url);
  return { server, page };
}

test("cancelling one millisecond before the event still pays the full refund", async ({ context }) => {
  const { server, page } = await freshVenue(context);
  const order = await bookThroughUI(page, "2");
  expect(order.totalCents, "fixture price changed — update the expected amounts").toBe(10000);

  // The last instant the window is open.
  await server.setClock(order.eventStartMs - 1);
  await cancelButton(page).click();

  // 10000 back less the 2% fee (200). A gate that closes a millisecond early
  // would show this customer 0 and keep money they are owed.
  await expect(refundLine(page), "the refund window is still open at eventStartMs - 1").toHaveText(
    "Refunded: 9800 cents",
  );
});

test("cancelling at the moment the event starts shows zero refunded", async ({ context }) => {
  const { server, page } = await freshVenue(context);
  const order = await bookThroughUI(page, "2");

  // `eventStartMs` itself is outside the window: "refunds close at this moment".
  await server.setClock(order.eventStartMs);
  await cancelButton(page).click();

  await expect(
    refundLine(page),
    "the window closes AT eventStartMs — the customer must be shown 0 cents back, not a payout",
  ).toHaveText("Refunded: 0 cents");
});

test("cancelling after the event has started shows zero refunded", async ({ context }) => {
  const { server, page } = await freshVenue(context);
  const order = await bookThroughUI(page, "10");
  // 10 x €50.00 with the 10% group tier.
  expect(order.totalCents, "fixture price changed — update the expected amounts").toBe(45000);

  // A full day into a show that has already happened.
  await server.setClock(order.eventStartMs + 24 * 3600 * 1000);
  await cancelButton(page).click();

  await expect(
    refundLine(page),
    "a no-show cancelled a day after the gig — the page must show 0 cents back, not the ticket price",
  ).toHaveText("Refunded: 0 cents");

  // And the spent order still cannot be cancelled a second time.
  await expect(cancelButton(page)).toBeHidden();
});

test("a cancellation after the event does not put the seats back on sale", async ({ context }) => {
  // The mirror image of refund-fee-floor's zero-refund case: there, 0 cents back
  // still frees the seat. Here the customer keeps the seat they paid for, so
  // reselling it would sell one seat twice.
  const { server, page } = await freshVenue(context);
  const order = await bookThroughUI(page, SEATS_LEFT);
  expect(order.totalCents, "fixture capacity changed — update SEATS_LEFT").toBe(SOLD_OUT_TOTAL);

  const latecomer = await context.newPage();
  const alerts = collectDialogs(latecomer);
  await latecomer.goto(server.url);
  await attemptBooking(latecomer, "1");
  await expect
    .poll(() => bookingOutcome(latecomer, alerts), { message: "expected the venue to be sold out before the cancel" })
    .toContain("not enough seats");

  await server.setClock(order.eventStartMs + 1);
  await cancelButton(page).click();
  // Precondition for the check below: the cancel went through and the page
  // answered. The amount it shows is the previous test's subject.
  await expect(refundLine(page)).toBeVisible();

  alerts.length = 0;
  await latecomer.reload();
  await attemptBooking(latecomer, "1");
  await expect
    .poll(() => bookingOutcome(latecomer, alerts), {
      message: "the seat was never refunded — putting it back on sale sells one seat to two people",
    })
    .toContain("not enough seats");
});
