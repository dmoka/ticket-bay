// The refund window, as the customer experiences it.
//
// src/refund.ts states the rule on `calculateRefund` (src/refund.ts:16-17):
//   "Business rule: cancellations are only allowed BEFORE the event starts.
//    From `eventStartMs` on, the refund is zero."
//
// `eventStartMs` is the closing instant, so the boundary is half-open: at
// `eventStartMs - 1` the customer is still owed their money, at `eventStartMs`
// they are not. These specs walk a real browser across that instant and read
// the amount rendered on the page.
//
// Reaching it needs a controllable clock — the demo event always starts 30 days
// after boot, so "cancel after the show began" is otherwise unreachable from a
// browser. support/harness.ts boots the REAL server with Date.now() frozen;
// the page, /api/book and /api/refund and the booking/refund modules behind
// them are all the genuine article. Nothing is mocked but "now".
import { test, expect, BrowserContext } from "@playwright/test";
import { startClockServer, ClockServer } from "./support/harness";
import { attemptBooking, bookingOutcome, bookThroughUI, cancelButton, collectDialogs, refundLine } from "./support/ui";

const running: ClockServer[] = [];

test.afterEach(() => {
  while (running.length) running.pop()!.stop();
});

/**
 * Books `tickets` on a pristine venue, then freezes the clock at
 * `whenMs(eventStartMs)` before the customer reaches for the cancel button.
 */
async function bookThenCancelAt(
  context: BrowserContext,
  tickets: string,
  whenMs: (eventStartMs: number) => number,
) {
  const server = await startClockServer();
  running.push(server);

  const buyer = await context.newPage();
  await buyer.goto(server.url);
  const order = await bookThroughUI(buyer, tickets);

  await server.setClock(whenMs(order.eventStartMs));
  await cancelButton(buyer).click();
  return { server, buyer, order };
}

test("cancelling one millisecond before the event still pays out in full", async ({ context }) => {
  const { buyer, order } = await bookThenCancelAt(context, "2", (start) => start - 1);
  expect(order.totalCents, "fixture price changed — update the expected refund").toBe(10000);

  // The window is still open, so the gate must not bite here: 10000 paid, 2%
  // fee (200), 9800 back. A gate that closes a moment early robs the customer.
  await expect(refundLine(buyer)).toBeVisible();
  await expect(refundLine(buyer), "the refund window is open until the event starts").toHaveText(
    "Refunded: 9800 cents",
  );
});

test("cancelling at the exact instant the event starts pays nothing back", async ({ context }) => {
  const { buyer, order } = await bookThenCancelAt(context, "2", (start) => start);
  expect(order.totalCents).toBe(10000);

  // `eventStartMs` is the closing instant, not the last open one. The customer
  // must be shown a zero refund, not the 9800 they would have got a millisecond
  // earlier.
  await expect(refundLine(buyer)).toBeVisible();
  await expect(
    refundLine(buyer),
    "the refund window closes AT eventStartMs — cancelling on the hour must pay zero",
  ).toHaveText("Refunded: 0 cents");
});

test("cancelling an hour into the show pays nothing back", async ({ context }) => {
  const { buyer } = await bookThenCancelAt(context, "2", (start) => start + 3600_000);

  // Well past the boundary: nobody can argue this one is a rounding edge.
  await expect(refundLine(buyer)).toBeVisible();
  await expect(refundLine(buyer), "the show has already started — there is nothing to refund").toHaveText(
    "Refunded: 0 cents",
  );
});

test("a cancellation after the event starts does not pay out a seat the venue keeps sold", async ({ context }) => {
  // The two halves of the rule have to agree, because they are enforced in
  // different places: the payout in src/refund.ts and the seat return in
  // server/server.ts:103. server.ts:97-102 is explicit that once the event has
  // started "the customer keeps neither the money nor the seat" and the seat
  // must NOT go back on sale. If the payout half is missing, the platform hands
  // over the money AND holds the seat off the market — it is out of pocket on
  // both sides of the same cancellation.
  const server = await startClockServer();
  running.push(server);

  // One customer takes the rest of the venue (100 seats, 40 sold).
  const buyer = await context.newPage();
  await buyer.goto(server.url);
  const order = await bookThroughUI(buyer, "60");
  expect(order.totalCents, "fixture capacity changed — update the seat count").toBe(270000);

  // Precondition: the page turns the next customer away.
  const latecomer = await context.newPage();
  const alerts = collectDialogs(latecomer);
  await latecomer.goto(server.url);
  await attemptBooking(latecomer, "1");
  await expect
    .poll(() => bookingOutcome(latecomer, alerts), { message: "expected the venue to be sold out before the cancel" })
    .toContain("not enough seats");

  await server.setClock(order.eventStartMs);
  await cancelButton(buyer).click();

  // Half one: no money moves.
  await expect(refundLine(buyer)).toBeVisible();
  await expect(
    refundLine(buyer),
    "cancelling after the event started paid the customer out — and the seat below stays sold, so the platform loses both",
  ).toHaveText("Refunded: 0 cents");

  // Half two: the seat stays with the customer who paid for it.
  alerts.length = 0;
  await latecomer.reload();
  await attemptBooking(latecomer, "1");
  await expect
    .poll(() => bookingOutcome(latecomer, alerts), {
      message: "a seat cancelled after the event started was resold — the original customer already owns it",
    })
    .toContain("not enough seats");
});
