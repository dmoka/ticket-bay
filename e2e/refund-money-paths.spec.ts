// Money paths through a real browser: what the customer is told they paid, and
// what they are told they got back. Every assertion is on rendered text or on a
// control the user can (or can no longer) click.
//
// Each test gets its OWN server (support/harness.ts), like the rest of the
// suite. These specs used to share Playwright's `webServer` on 4173 with
// booking-refund.spec.ts, and that server keeps `orders` and `event.seatsSold`
// as module-level state (server/server.ts:21 and the `event` object). Two spec
// files running in parallel workers were mutating one venue's inventory while
// asserting exact amounts against it — and because `reuseExistingServer` hands
// a leaked server to the NEXT run, that state outlived the run that created it.
// A pristine venue per test is what makes an exact-cents assertion meaningful.
import { test, expect, BrowserContext } from "@playwright/test";
import { startClockServer, ClockServer } from "./support/harness";
import { cancelButton, collectDialogs, paidLine, refundLine } from "./support/ui";

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
  return page;
}

test("group booking: the refund matches the discounted price the user was charged", async ({ context }) => {
  const page = await freshVenue(context);
  await page.getByLabel("Tickets:").fill("10");
  await page.getByRole("button", { name: "Book tickets" }).click();

  // 10 x €50.00 with the 10% group discount -> 45000 cents charged.
  await expect(paidLine(page)).toHaveText(/^Paid: 45000 cents /);

  await page.getByRole("button", { name: "Cancel order" }).click();
  // Refund is proportional to what was PAID (45000), minus the 2% fee (900).
  await expect(refundLine(page)).toHaveText("Refunded: 44100 cents");
});

test("the 5-ticket group tier is charged and refunded at 5%, not 10%", async ({ context }) => {
  const page = await freshVenue(context);
  await page.getByLabel("Tickets:").fill("5");
  await page.getByRole("button", { name: "Book tickets" }).click();

  // 5 x €50.00 crosses the 5% tier but not the 10% one -> 23750 cents charged.
  await expect(paidLine(page), "5 tickets must get the 5% tier, not 10%").toHaveText(/^Paid: 23750 cents /);

  await page.getByRole("button", { name: "Cancel order" }).click();
  // 2% of 23750 is 475, so the customer must see 23275 back.
  await expect(refundLine(page)).toHaveText("Refunded: 23275 cents");
});

test("four tickets get no group discount, and the refund reflects the full price", async ({ context }) => {
  const page = await freshVenue(context);
  await page.getByLabel("Tickets:").fill("4");
  await page.getByRole("button", { name: "Book tickets" }).click();

  // One short of the 5% tier -> full 20000 cents.
  await expect(paidLine(page), "4 tickets is below the group tier — no discount").toHaveText(/^Paid: 20000 cents /);

  await page.getByRole("button", { name: "Cancel order" }).click();
  await expect(refundLine(page)).toHaveText("Refunded: 19600 cents");
});

test("a refunded order cannot be cancelled twice from the page", async ({ context }) => {
  const page = await freshVenue(context);
  await page.getByLabel("Tickets:").fill("2");
  await page.getByRole("button", { name: "Book tickets" }).click();
  await expect(paidLine(page)).toHaveText(/^Paid: 10000 cents /);

  const cancel = cancelButton(page);
  await cancel.click();
  await expect(refundLine(page)).toHaveText("Refunded: 9800 cents");

  // The customer must not be able to trigger a second payout for the same order.
  await expect(cancel).toBeHidden();
  await expect(refundLine(page)).toHaveText("Refunded: 9800 cents");
});

test("a booking bigger than the venue is refused and charges nothing", async ({ context }) => {
  const page = await freshVenue(context);
  const dialogs = collectDialogs(page);

  await page.getByLabel("Tickets:").fill("999");
  await page.getByRole("button", { name: "Book tickets" }).click();

  await expect.poll(() => dialogs.join("|")).toContain("not enough seats");
  // No order was created, so there is nothing to pay and nothing to cancel.
  await expect(paidLine(page)).toBeHidden();
  await expect(cancelButton(page)).toBeHidden();
});
