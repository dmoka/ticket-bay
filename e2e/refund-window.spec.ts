// Money paths 2 and 3: the refund WINDOW, as the customer experiences it.
//
// src/domain/refund.ts: "cancellations are only allowed BEFORE the event
// starts. From `eventStartMs` on, the refund is zero." — and seats go back on
// sale only while the window is open. Each spec books at a fixed instant, moves
// the app's clock to one side of the edge, and asserts the AMOUNT on the page
// and the SEATS on the event page.
import { test, expect } from "@playwright/test";
import { BOOKING_AT_MS, E2E_EVENTS, E2E_USERS, EVENT_START_MS } from "./support/env";
import { bookThroughUI, cancelButton, cancelOnPage, refundLine, seatsLeft, setClock, signIn, ticketsLine, totalLine } from "./support/app";

test("cancelling inside the window refunds the tickets less the fee and puts the seats back on sale", async ({ page, context }) => {
  const ev = E2E_EVENTS.refundInWindow;
  const customer = E2E_USERS.refundInWindow;
  await setClock(context, BOOKING_AT_MS);
  await signIn(page, customer);
  await bookThroughUI(page, customer, ev, "2");
  await expect(ticketsLine(page)).toHaveText("Tickets €100.00");
  await expect(totalLine(page)).toHaveText("Total paid €103.00");

  // The last instant the window is open: a gate that closes a millisecond early would show €0.00.
  await setClock(context, EVENT_START_MS - 1);
  await cancelOnPage(page);
  // Refund is on the €100.00 paid for tickets, less the 2% fee (€2.00). The €3.00 service fee is kept.
  await expect(refundLine(page)).toHaveText("Refunded €98.00");
  await expect(cancelButton(page), "no second payout for the same order").toBeHidden();

  await setClock(context, BOOKING_AT_MS);
  await page.goto(`/events/${ev}`);
  await expect(seatsLeft(page), "the refunded seats are for sale again").toHaveText("60 / 100");
});

test("cancelling once the event has started refunds nothing and the seats stay sold", async ({ page, context }) => {
  const ev = E2E_EVENTS.refundAfterStart;
  const customer = E2E_USERS.refundAfterStart;
  await setClock(context, BOOKING_AT_MS);
  await signIn(page, customer);
  await bookThroughUI(page, customer, ev, "2");

  // `eventStartMs` itself is outside the window: "refunds close at this moment".
  await setClock(context, EVENT_START_MS);
  await page.reload();
  await expect(page.getByText("The refund window has closed.")).toBeVisible();
  await cancelOnPage(page);
  await expect(refundLine(page), "the window closes AT eventStartMs — €0.00 back, not a payout").toHaveText("Refunded €0.00");
  await expect(page.getByText("the seats stay yours")).toBeVisible();
  await expect(cancelButton(page)).toBeHidden();

  await setClock(context, BOOKING_AT_MS);
  await page.goto(`/events/${ev}`);
  await expect(seatsLeft(page), "a late cancellation must not free the seats").toHaveText("58 / 100");
});
