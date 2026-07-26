// The refund WINDOW, as the customer experiences it.
//
// src/refund.ts states the rule on `calculateRefund`:
//   "Business rule: cancellations are only allowed BEFORE the event starts.
//    From `eventStartMs` on, the refund is zero."
//
// So the boundary is half-open: refundable up to `eventStartMs - 1`, zero from
// `eventStartMs` onwards. These specs drive a real browser to each side of that
// instant and assert the amount rendered on the page. Each test gets its own
// clock-controlled server (support/harness.ts) — the real page, the real
// /api/book and /api/refund, only "now" under test control, because the demo
// event always starts 30 days after boot and is otherwise unreachable.
import { test, expect, BrowserContext } from "@playwright/test";
import { startClockServer, ClockServer } from "./support/harness";
import { bookThroughUI, cancelButton, refundLine } from "./support/ui";

// Own port range so this file never fights the other harness-based specs.
let nextPort = 4400;
const running: ClockServer[] = [];

test.afterEach(() => {
  while (running.length) running.pop()!.stop();
});

/**
 * Books `tickets` on a pristine venue, moves the server clock to
 * `whenMs(eventStartMs)`, then cancels through the page. Returns the buyer's
 * page and the order the server really created, so assertions can be written
 * against the amount actually charged rather than a copied constant.
 */
async function bookThenCancelAt(context: BrowserContext, tickets: string, whenMs: (eventStartMs: number) => number) {
  const server = await startClockServer(nextPort++, nextPort++);
  running.push(server);

  const buyer = await context.newPage();
  await buyer.goto(server.url);
  const order = await bookThroughUI(buyer, tickets);

  await server.setClock(whenMs(order.eventStartMs));
  await cancelButton(buyer).click();
  return { buyer, order };
}

test("one millisecond before the event, the customer still gets the full refund", async ({ context }) => {
  const { buyer, order } = await bookThenCancelAt(context, "2", (start) => start - 1);

  // Inside the window: 10000 paid, 2% fee = 200, so the page must show 9800.
  expect(order.totalCents, "fixture price changed — update the expected refund").toBe(10000);
  await expect(refundLine(buyer)).toHaveText("Refunded: 9800 cents");
});

test("at the exact moment the event starts, the refund the customer is shown is zero", async ({ context }) => {
  const { buyer } = await bookThenCancelAt(context, "2", (start) => start);

  // "From `eventStartMs` on, the refund is zero" — the boundary instant is
  // already outside the window, so the page must show nothing coming back.
  await expect(
    refundLine(buyer),
    "the refund window closes AT the event start, so cancelling on that instant must pay out 0",
  ).toHaveText("Refunded: 0 cents");
});

test("an hour after the event has started, the customer is shown no refund", async ({ context }) => {
  const { buyer } = await bookThenCancelAt(context, "2", (start) => start + 3600_000);

  await expect(
    refundLine(buyer),
    "cancelling after the show began must pay out 0 — the page is telling the customer money is coming back",
  ).toHaveText("Refunded: 0 cents");
});

test("a group order cancelled after the event pays out nothing either", async ({ context }) => {
  // 10 x €50.00 less the 10% group discount = 45000 charged; in-window this
  // would return 44100. The bigger the order, the bigger the leak, so pin it.
  const { buyer, order } = await bookThenCancelAt(context, "10", (start) => start + 24 * 3600_000);

  expect(order.totalCents, "fixture price/discount changed — update the expected charge").toBe(45000);
  await expect(refundLine(buyer)).toHaveText("Refunded: 0 cents");
});
