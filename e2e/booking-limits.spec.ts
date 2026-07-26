// The edges of the ticket field, as a real user can actually drive it.
//
// `bookTickets` rejects an order whose gross exceeds Number.MAX_SAFE_INTEGER
// (src/booking.ts:28) so the refund path can never be handed a total it refuses
// — an order that is paid for but permanently unrefundable is the worst
// outcome on this money path. That guard sits AFTER the capacity check
// (src/booking.ts:26), which is what keeps it off every route a customer can
// reach: the venue has 60 seats left, so no quantity the field can submit gets
// far enough to overflow. These specs pin that, so a future reordering of those
// two checks shows up as a customer being told the wrong thing.
//
// Own server per test (support/harness.ts): these fill the venue, which would
// starve the specs sharing the server on 4173.
import { test, expect, BrowserContext } from "@playwright/test";
import { startClockServer, ClockServer } from "./support/harness";
import { attemptBooking, bookingOutcome, bookThroughUI, cancelButton, collectDialogs, paidLine, refundLine } from "./support/ui";

// Own port range so this file never fights the other harness-based specs.
let nextPort = 4700;
const running: ClockServer[] = [];

test.afterEach(() => {
  while (running.length) running.pop()!.stop();
});

async function freshVenue(context: BrowserContext, env: Record<string, string> = {}) {
  const server = await startClockServer(nextPort++, nextPort++, env);
  running.push(server);
  return server;
}

test("the last seat in the venue is bookable, and one more than that is refused", async ({ context }) => {
  const server = await freshVenue(context);

  // Fixture: 100 seats, 40 sold, so 60 left. Ask for 61 first.
  const overreach = await context.newPage();
  const alerts = collectDialogs(overreach);
  await overreach.goto(server.url);
  await attemptBooking(overreach, "61");
  await expect.poll(() => bookingOutcome(overreach, alerts)).toContain("not enough seats");

  // The refused booking must not have eaten inventory: exactly 60 are still
  // for sale, and the next customer can take all of them.
  const buyer = await context.newPage();
  await buyer.goto(server.url);
  const order = await bookThroughUI(buyer, "60");
  // 60 x €50.00 less the 10% group discount.
  expect(order.totalCents, "the largest order the venue can sell must still go through").toBe(270000);
  await expect(paidLine(buyer)).toHaveText(/^Paid: 270000 cents /);
});

test("a ticket count far beyond the venue reads as a capacity problem, not an arithmetic one", async ({ context }) => {
  const server = await freshVenue(context);
  const page = await context.newPage();
  const alerts = collectDialogs(page);
  await page.goto(server.url);

  // A number field accepts exponent notation and values past 2^53, so these are
  // all things a user can genuinely submit. Every one of them is a request for
  // more seats than exist, and that is what the customer must be told — being
  // told the order total is out of range would be meaningless to them.
  for (const typed of ["1e21", "9007199254740993", "999999999999999999999999"]) {
    alerts.length = 0;
    await page.reload();
    await attemptBooking(page, typed);
    // The alert lands a tick after the response `attemptBooking` waits for, so
    // the outcome has to be polled, not read once.
    await expect
      .poll(() => bookingOutcome(page, alerts), { message: `typing ${typed} should read as a sold-out venue` })
      .toContain("not enough seats");
    const outcome = await bookingOutcome(page, alerts);
    expect(outcome, `typing ${typed} must not surface an arithmetic error`).not.toContain("order total out of range");
    // Nothing was sold, so there is nothing to pay for and nothing to cancel.
    await expect(paidLine(page)).toBeHidden();
  }
});

test("an order too large for the refund path is refused up front, and the largest safe one still refunds", async ({
  context,
}) => {
  // The only way to reach the overflow guard is a ticket price that makes two
  // seats overflow, which no customer can cause but an operator can configure.
  const server = await freshVenue(context, { PRICE_CENTS: String(Number.MAX_SAFE_INTEGER) });

  const overflow = await context.newPage();
  const alerts = collectDialogs(overflow);
  await overflow.goto(server.url);
  await attemptBooking(overflow, "2");
  // Refused at booking. Selling it would take the customer's money for an order
  // `calculateRefund` rejects, so the cancel button could never pay it back.
  await expect
    .poll(() => bookingOutcome(overflow, alerts), {
      message: "an order the refund path cannot handle must be refused before the customer pays",
    })
    .toContain("order total out of range");
  await expect(paidLine(overflow)).toBeHidden();

  // ...and the guard is not over-tight: the largest order that IS safe still
  // sells, and the customer can still get their money back.
  const buyer = await context.newPage();
  await buyer.goto(server.url);
  const order = await bookThroughUI(buyer, "1");
  expect(order.totalCents).toBe(Number.MAX_SAFE_INTEGER);

  await cancelButton(buyer).click();
  // 9007199254740991 less the 2% fee (180143985094820).
  await expect(refundLine(buyer), "a booking the guard allowed must be refundable").toHaveText(
    "Refunded: 8827055269646171 cents",
  );
});
