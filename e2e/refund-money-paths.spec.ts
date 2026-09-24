// Money paths through a real browser: what the customer is told they paid, and
// what they are told they got back. Every assertion is on rendered text or on
// a control the user can (or can no longer) click.
import { test, expect } from "@playwright/test";
import {
  bookThroughUI,
  cancelButton,
  cancelOnPage,
  checkoutError,
  ensureCode,
  freshVenue,
  refundLine,
  seatsLeft,
  startCheckout,
  ticketsLine,
} from "./support/app";

test("group booking: the refund matches the discounted price the user was charged", async ({ page }) => {
  const ev = freshVenue();
  await bookThroughUI(page, ev, "10");
  // 10 x €50.00 with the 10% group discount.
  await expect(ticketsLine(page)).toHaveText("Tickets €450.00");
  await cancelOnPage(page);
  // Refund is proportional to what was PAID (€450.00), minus the 2% fee (€9.00).
  await expect(refundLine(page)).toHaveText("Refunded €441.00");
});

test("the 5-ticket group tier is charged and refunded at 5%, not 10%", async ({ page }) => {
  const ev = freshVenue();
  await bookThroughUI(page, ev, "5");
  await expect(ticketsLine(page), "5 tickets must get the 5% tier, not 10%").toHaveText("Tickets €237.50");
  await cancelOnPage(page);
  // 2% of €237.50 is €4.75.
  await expect(refundLine(page)).toHaveText("Refunded €232.75");
});

test("four tickets get no group discount, and the refund reflects the full price", async ({ page }) => {
  const ev = freshVenue();
  await bookThroughUI(page, ev, "4");
  await expect(ticketsLine(page), "4 tickets is below the group tier — no discount").toHaveText("Tickets €200.00");
  await cancelOnPage(page);
  await expect(refundLine(page)).toHaveText("Refunded €196.00");
});

test("a refunded order cannot be cancelled twice from the page", async ({ page }) => {
  const ev = freshVenue();
  await bookThroughUI(page, ev, "2");
  await cancelOnPage(page);
  await expect(refundLine(page)).toHaveText("Refunded €98.00");
  // The customer must not be able to trigger a second payout for the same order.
  await expect(cancelButton(page)).toBeHidden();
  await page.reload();
  await expect(cancelButton(page)).toBeHidden();
  await expect(refundLine(page)).toHaveText("Refunded €98.00");
});

test("a booking bigger than the venue is refused and charges nothing", async ({ page }) => {
  const ev = freshVenue();
  await startCheckout(page, ev, "999");
  await expect(checkoutError(page)).toHaveText("Not enough seats — only 60 left.");
  await expect(page.getByRole("button", { name: /^Pay/ })).toBeDisabled();
  // No order was created, so no seat was taken.
  await page.goto(`/events/${ev.id}`);
  await expect(seatsLeft(page)).toHaveText("60 / 100");
});

test("a discount code is applied at checkout and shows up on the refund", async ({ page }) => {
  const ev = freshVenue();
  ensureCode("WELCOME10", 10);
  await page.goto(`/events/${ev.id}/checkout?qty=2`);
  await page.getByLabel("Discount code").fill("welcome10");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("WELCOME10 applied")).toBeVisible();
  await expect(ticketsLine(page)).toHaveText("Tickets €90.00");
  await page.getByLabel("Email").fill("coder@example.com");
  await page.getByLabel("Name on tickets").fill("A Coder");
  await page.getByRole("button", { name: "Pay €92.70" }).click();
  await page.waitForURL(/\/orders\/\d+/);
  await expect(ticketsLine(page)).toHaveText("Tickets €90.00");
  await cancelOnPage(page);
  // €90.00 less the 2% fee (€1.80).
  await expect(refundLine(page)).toHaveText("Refunded €88.20");
});

test("an unknown discount code is explained and never blocks the order", async ({ page }) => {
  const ev = freshVenue();
  await page.goto(`/events/${ev.id}/checkout?qty=2&code=NOPE`);
  await expect(page.getByText("Unknown discount code.")).toBeVisible();
  await expect(ticketsLine(page)).toHaveText("Tickets €100.00");
  await expect(page.getByRole("button", { name: "Pay €103.00" })).toBeEnabled();
});
