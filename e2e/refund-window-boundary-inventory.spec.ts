// The closing edge of the refund window, seen through INVENTORY as well as money.
//
// refund-after-event-window.spec.ts asserts the amount on each side of
// `eventStartMs`. This file asserts the other half of the same rule, which the
// customer feels just as directly: whose seat it is afterwards.
//
// server/server.ts:103 returns seats to sale only while `now < eventStartMs`,
// the complement of the `nowMs >= order.eventStartMs` gate in src/refund.ts.
// Every existing spec probes that gate at `eventStartMs - 1` (seats come back)
// or at `+1ms` / `+1 day` (they do not), and all three still pass if the gate
// slips to `now <= eventStartMs`. The instant it is written to exclude is the
// one nothing checked: at exactly `eventStartMs` a customer is paid 0 and must
// still hold their seat. Freeing it there is the worst outcome in the system —
// the customer loses the money AND the seat, and the venue sells that seat to a
// second person.
//
// Own clock-controlled server per test (support/harness.ts), like the rest of
// the suite: the venue is module-level state, so a shared one makes an exact
// seat count meaningless. Nothing is mocked — real page, real /api/book and
// /api/refund, only "now" is under test control.
import { test, expect, BrowserContext, Page } from "@playwright/test";
import { startClockServer, ClockServer } from "./support/harness";
import {
  attemptBooking,
  bookingOutcome,
  bookThroughUI,
  cancelButton,
  collectDialogs,
  paidLine,
  refundLine,
} from "./support/ui";

// Fixture capacity from server/server.ts: 100 seats, 40 already sold, €50.00 each.
const SEATS_LEFT = 60;
// 60 x €50.00 less the 10% group discount.
const SOLD_OUT_TOTAL = 270000;

const running: ClockServer[] = [];

test.afterEach(() => {
  while (running.length) running.pop()!.stop();
});

/** A freshly booted venue, stopped again by the afterEach above. */
async function freshVenue() {
  const server = await startClockServer();
  running.push(server);
  return server;
}

async function customerOn(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

/**
 * A customer who keeps trying to buy, and reports what the page tells them.
 * Booking happens once per attempt and the outcome is polled separately: an
 * alert is a one-shot event, so a poll that re-books each round would keep
 * throwing away the very message it is waiting for.
 */
async function latecomerOn(context: BrowserContext, url: string) {
  const page = await customerOn(context, url);
  const alerts = collectDialogs(page);
  return {
    async tryToBuy(tickets: string) {
      alerts.length = 0;
      await page.reload();
      await attemptBooking(page, tickets);
    },
    outcome: () => bookingOutcome(page, alerts),
  };
}

test("at the exact moment the event starts, the customer is paid nothing and keeps the seat", async ({ context }) => {
  const server = await freshVenue();
  const buyer = await customerOn(context, server.url);
  const order = await bookThroughUI(buyer, String(SEATS_LEFT));
  expect(order.totalCents, "fixture capacity or price changed — update SEATS_LEFT").toBe(SOLD_OUT_TOTAL);

  const latecomer = await latecomerOn(context, server.url);
  await latecomer.tryToBuy("1");
  await expect
    .poll(latecomer.outcome, { message: "expected the venue to be sold out before the cancel" })
    .toContain("not enough seats");

  // Exactly the closing instant — inside no part of the window.
  await server.setClock(order.eventStartMs);
  await cancelButton(buyer).click();

  // Everything the buyer can see has to tell one story: the show has started,
  // so no money comes back...
  await expect(refundLine(buyer), "the window is shut at eventStartMs — nothing is owed").toHaveText(
    "Refunded: 0 cents",
  );
  // ...what they paid is still on screen, so the zero is legible as "kept" and
  // not as "we lost your order"...
  await expect(paidLine(buyer), "the customer must still be able to see what they paid").toHaveText(
    /^Paid: 270000 cents /,
  );
  // ...and the order is spent, so they cannot ask for a second payout.
  await expect(cancelButton(buyer)).toBeHidden();

  // ...and the seat is still theirs. This is the assertion the `+1ms` cases
  // cannot make: at exactly eventStartMs a `<=` gate would put a seat the
  // customer paid for and was NOT refunded back on sale to someone else.
  await latecomer.tryToBuy("1");
  await expect
    .poll(latecomer.outcome, {
      message:
        "a seat was resold at exactly eventStartMs — that customer was paid 0 cents and still holds it, " +
        "so the venue just sold one seat twice",
    })
    .toContain("not enough seats");
});

test("cancelling in time frees exactly those seats, and cancelling too late frees none", async ({ context }) => {
  // Two customers split the remaining venue, cancel a millisecond apart across
  // the boundary, and the next customer's options say which of them got their
  // seats back. Counting the seats — not merely "some came back" — is what
  // separates the correct gate from one that releases both orders or neither.
  const server = await freshVenue();
  const half = SEATS_LEFT / 2;

  const inTime = await customerOn(context, server.url);
  const order = await bookThroughUI(inTime, String(half));
  // 30 x €50.00 with the 10% group tier.
  expect(order.totalCents, "fixture capacity or price changed — update the expected amounts").toBe(135000);

  const tooLate = await customerOn(context, server.url);
  await bookThroughUI(tooLate, String(half));

  const latecomer = await latecomerOn(context, server.url);
  await latecomer.tryToBuy("1");
  await expect
    .poll(latecomer.outcome, { message: "expected the venue to be sold out before the cancels" })
    .toContain("not enough seats");

  // One millisecond before: paid in full, less the 2% fee (2700).
  await server.setClock(order.eventStartMs - 1);
  await cancelButton(inTime).click();
  await expect(refundLine(inTime), "the window is still open at eventStartMs - 1").toHaveText("Refunded: 132300 cents");

  // One millisecond later, the window is shut: nothing back.
  await server.setClock(order.eventStartMs);
  await cancelButton(tooLate).click();
  await expect(refundLine(tooLate)).toHaveText("Refunded: 0 cents");

  // 30 seats are the venue's again; the other 30 belong to the customer who was
  // never paid for them. Asking for one more than that must still be refused.
  await latecomer.tryToBuy(String(half + 1));
  await expect
    .poll(latecomer.outcome, {
      message: `${half + 1} seats were sold when only the in-time cancellation's ${half} were free — ` +
        "the unrefunded order's seats went back on sale",
    })
    .toContain("not enough seats");

  await latecomer.tryToBuy(String(half));
  await expect
    .poll(latecomer.outcome, {
      message: `the ${half} seats of a refunded, in-time cancellation never came back on sale`,
    })
    .toContain("Paid: 135000 cents");
});
