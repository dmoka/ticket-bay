// The "too late to cancel" money path.
//
// src/refund.ts is explicit: "cancellations are only allowed BEFORE the event
// starts. From `eventStartMs` on, the refund is zero." A customer who clicks
// Cancel once the show has begun must be shown 0, not a payout.
//
// The demo event always starts 30 days after the server boots, so this path is
// unreachable in a browser against the default server. These tests run the SAME
// server module on a second port, in a child process whose Date.now() is frozen
// and steerable (see support/clock-server.ts). No request is mocked or stubbed:
// the page, the endpoints and the refund maths are all real.
import { test, expect } from "@playwright/test";
import { startClockServer, ClockServer } from "./support/harness";
import { bookThroughUI, cancelButton, paidLine, refundLine } from "./support/ui";

let server: ClockServer;

test.beforeAll(async () => {
  server = await startClockServer(4273, 4274);
});

// Every test books while the clock is still well before the event.
test.beforeEach(async () => {
  await server.resetClock();
});

test.afterAll(() => server?.stop());

test("cancelling at the instant the event starts pays out nothing", async ({ page }) => {
  await page.goto(server.url);
  const order = await bookThroughUI(page, "2");
  await expect(paidLine(page)).toHaveText(/^Paid: 10000 cents /);

  // Doors open. Refunds close at exactly this instant.
  await server.setClock(order.eventStartMs);

  await cancelButton(page).click();
  await expect(refundLine(page)).toHaveText("Refunded: 0 cents");
});

test("cancelling a day after the event started pays out nothing", async ({ page }) => {
  await page.goto(server.url);
  const order = await bookThroughUI(page, "2");
  await expect(paidLine(page)).toHaveText(/^Paid: 10000 cents /);

  await server.setClock(order.eventStartMs + 24 * 3600 * 1000);

  await cancelButton(page).click();
  await expect(refundLine(page)).toHaveText("Refunded: 0 cents");
});

test("cancelling one millisecond before the event still pays the full refund", async ({ page }) => {
  await page.goto(server.url);
  const order = await bookThroughUI(page, "2");
  await expect(paidLine(page)).toHaveText(/^Paid: 10000 cents /);

  // The last instant the customer is still entitled to their money — the other
  // side of the same boundary, so a gate that closes a moment too early is
  // caught on screen too.
  await server.setClock(order.eventStartMs - 1);

  await cancelButton(page).click();
  await expect(refundLine(page)).toHaveText("Refunded: 9800 cents");
});
