// Money paths through a real browser: what the customer is told they paid, and
// what they are told they got back. Every assertion is on rendered text or on a
// control the user can (or can no longer) click.
import { test, expect } from "@playwright/test";
import { cancelButton, paidLine, refundLine } from "./support/ui";

test("group booking: the refund matches the discounted price the user was charged", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Tickets:").fill("10");
  await page.getByRole("button", { name: "Book tickets" }).click();

  // 10 x €50.00 with the 10% group discount -> 45000 cents charged.
  await expect(paidLine(page)).toHaveText(/^Paid: 45000 cents /);

  await page.getByRole("button", { name: "Cancel order" }).click();
  // Refund is proportional to what was PAID (45000), minus the 2% fee (900).
  await expect(refundLine(page)).toHaveText("Refunded: 44100 cents");
});

test("a refunded order cannot be cancelled twice from the page", async ({ page }) => {
  await page.goto("/");
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

test("a booking bigger than the venue is refused and charges nothing", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.dismiss();
  });

  await page.goto("/");
  await page.getByLabel("Tickets:").fill("999");
  await page.getByRole("button", { name: "Book tickets" }).click();

  await expect.poll(() => dialogs.join("|")).toContain("not enough seats");
  // No order was created, so there is nothing to pay and nothing to cancel.
  await expect(paidLine(page)).toBeHidden();
  await expect(cancelButton(page)).toBeHidden();
});
