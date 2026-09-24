// The refund WINDOW, as the customer experiences it.
//
// src/domain/refund.ts states the rule on `calculateRefund`:
//   "Business rule: cancellations are only allowed BEFORE the event starts.
//    From `eventStartMs` on, the refund is zero."
// and src/services/orders.ts returns seats to sale only while the window is
// open. These specs move the app's clock for one browser context (a cookie the
// server honors only under TICKETBAY_TEST_CLOCK=1) across that edge and assert
// the AMOUNT on the page and the SEATS on the event page on each side of it.
import { test, expect } from "@playwright/test";
import { bookThroughUI, cancelButton, cancelOnPage, freshVenue, refundLine, seatsLeft, setClock } from "./support/app";

test("cancelling one millisecond before the event still pays the full refund", async ({ page, context }) => {
  const ev = freshVenue();
  await bookThroughUI(page, ev, "2");
  // The last instant the window is open.
  await setClock(context, ev.startsAtMs - 1);
  await cancelOnPage(page);
  // A gate that closes a millisecond early would show this customer €0.00.
  await expect(refundLine(page), "the refund window is still open at eventStartMs - 1").toHaveText("Refunded €98.00");
});

test("cancelling at the moment the event starts shows zero refunded", async ({ page, context }) => {
  const ev = freshVenue();
  await bookThroughUI(page, ev, "2");
  // `eventStartMs` itself is outside the window: "refunds close at this moment".
  await setClock(context, ev.startsAtMs);
  await page.reload();
  await expect(page.getByText("The refund window has closed.")).toBeVisible();
  await cancelOnPage(page);
  await expect(refundLine(page), "the window closes AT eventStartMs — €0.00 back, not a payout").toHaveText("Refunded €0.00");
});

test("cancelling after the event has started shows zero refunded, once", async ({ page, context }) => {
  const ev = freshVenue();
  await bookThroughUI(page, ev, "10");
  // A full day into a show that has already happened.
  await setClock(context, ev.startsAtMs + 86_400_000);
  await cancelOnPage(page);
  await expect(refundLine(page), "a no-show cancelled a day after the gig must see €0.00").toHaveText("Refunded €0.00");
  await expect(cancelButton(page)).toBeHidden();
});

test("cancelling before the event puts the seats back on sale", async ({ browser }) => {
  const ev = freshVenue();
  const buyerCtx = await browser.newContext();
  const buyer = await buyerCtx.newPage();
  await bookThroughUI(buyer, ev, "60");

  // Precondition: sold out, and the page says so to the next customer.
  const latecomer = await (await browser.newContext()).newPage();
  await latecomer.goto(`/events/${ev.id}`);
  await expect(seatsLeft(latecomer)).toHaveText("0 / 100");
  await expect(latecomer.getByText("Sold out — no seats left.")).toBeVisible();

  await setClock(buyerCtx, ev.startsAtMs - 1);
  await cancelOnPage(buyer);
  // 60 x €50.00 less the 10% group tier = €2,700.00; less the 2% fee (€54.00).
  await expect(refundLine(buyer)).toHaveText("Refunded €2,646.00");

  // The customer was paid back, so the seats are the venue's to sell again.
  await latecomer.reload();
  await expect(seatsLeft(latecomer)).toHaveText("60 / 100");
  await bookThroughUI(latecomer, ev, "1");
  await expect(latecomer.getByTestId("line-tickets")).toHaveText("Tickets €50.00");
});

for (const [when, offset] of [
  ["at the exact instant the event starts", 0],
  ["after the event has started", 1],
] as const) {
  test(`a cancellation ${when} does not put the seats back on sale`, async ({ browser }) => {
    // The customer keeps the seat they paid for; reselling it would sell one seat twice.
    const ev = freshVenue();
    const buyerCtx = await browser.newContext();
    const buyer = await buyerCtx.newPage();
    await bookThroughUI(buyer, ev, "60");

    await setClock(buyerCtx, ev.startsAtMs + offset);
    await cancelOnPage(buyer);
    await expect(refundLine(buyer)).toHaveText("Refunded €0.00");
    await expect(buyer.getByText("the seats stay yours")).toBeVisible();

    // Another customer, looking before the show: still sold out.
    const latecomer = await (await browser.newContext()).newPage();
    await latecomer.goto(`/events/${ev.id}`);
    await expect(seatsLeft(latecomer), "a late cancellation must not free the seat").toHaveText("0 / 100");
    await latecomer.goto(`/events/${ev.id}/checkout?qty=1`);
    await expect(latecomer.getByTestId("checkout-error")).toHaveText("Sold out — not enough seats left.");
  });
}

test("sales close when the event starts", async ({ page, context }) => {
  const ev = freshVenue();
  await setClock(context, ev.startsAtMs);
  await page.goto(`/events/${ev.id}`);
  await expect(page.getByText("This event has already taken place.")).toBeVisible();
  await page.goto(`/events/${ev.id}/checkout?qty=1`);
  await expect(page.getByTestId("checkout-error")).toHaveText("Sales are closed — this event has already started.");
});
