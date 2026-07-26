// What a cancellation does to inventory: a refunded order's seats belong back
// on sale, and the next customer must be able to buy them.
//
// Each test gets its own clock-controlled server (see support/harness.ts) so it
// starts from a pristine, untouched venue.
import { test, expect, BrowserContext } from "@playwright/test";
import { startClockServer, ClockServer } from "./support/harness";
import { attemptBooking, bookingOutcome, bookThroughUI, cancelButton, collectDialogs, refundLine } from "./support/ui";

// Fixture capacity from server/server.ts: 100 seats, 40 already sold.
const SEATS_LEFT = "60";
// 60 x €50.00 less the 10% group discount.
const SOLD_OUT_TOTAL = 270000;

let nextPort = 4275;
const running: ClockServer[] = [];

test.afterEach(() => {
  while (running.length) running.pop()!.stop();
});

/**
 * Sells out the venue, proves the page turns the next customer away, then
 * cancels the whole order at `whenMs(eventStartMs)`. Returns the handles the
 * test needs to check what each customer ends up seeing.
 */
async function sellOutThenCancelAt(context: BrowserContext, whenMs: (eventStartMs: number) => number) {
  const server = await startClockServer(nextPort++, nextPort++);
  running.push(server);

  const buyer = await context.newPage();
  const latecomer = await context.newPage();
  const alerts = collectDialogs(latecomer);

  // One customer takes the rest of the venue.
  await buyer.goto(server.url);
  const order = await bookThroughUI(buyer, SEATS_LEFT);
  expect(order.totalCents, "fixture capacity changed — update SEATS_LEFT").toBe(SOLD_OUT_TOTAL);

  // Precondition: the show is sold out, and the page says so.
  await latecomer.goto(server.url);
  await attemptBooking(latecomer, "1");
  await expect
    .poll(() => bookingOutcome(latecomer, alerts), { message: "expected the venue to be sold out before the cancel" })
    .toContain("not enough seats");

  await server.setClock(whenMs(order.eventStartMs));
  await cancelButton(buyer).click();

  /**
   * The next customer tries again after the cancel. Booking happens once, and
   * the outcome is polled separately — an alert is a one-shot event, so a poll
   * that re-books each round would keep throwing away the very message it is
   * waiting for.
   */
  const retryBooking = async () => {
    alerts.length = 0;
    await latecomer.reload();
    await attemptBooking(latecomer, "1");
  };
  const outcome = () => bookingOutcome(latecomer, alerts);
  return { buyer, latecomer, retryBooking, outcome };
}

test("cancelling before the event puts the seats back on sale", async ({ context }) => {
  const { buyer, retryBooking, outcome } = await sellOutThenCancelAt(context, (start) => start - 1);

  // In time: 270000 back less the 2% fee (5400).
  await expect(refundLine(buyer)).toHaveText("Refunded: 264600 cents");

  // The customer was paid, so the seats are the venue's to sell again.
  await retryBooking();
  await expect
    .poll(outcome, {
      message: "a refunded cancellation left the venue sold out — those seats were paid back and belong on sale",
    })
    .toContain("Paid: 5000 cents");
});

test("cancelling once the event has started keeps the seats sold", async ({ context }) => {
  const { retryBooking, outcome } = await sellOutThenCancelAt(context, (start) => start);

  // The refund window has closed, so the customer keeps the seat they paid for.
  // Putting it back on sale would sell a paid-for seat to someone else.
  await retryBooking();
  await expect
    .poll(outcome, {
      message: "a seat cancelled after the event started was resold — the original customer already owns it",
    })
    .toContain("not enough seats");
});
