// The money path, through a real browser. Assert what the user SEES —
// the refund amount rendered on the page, never just "page loaded".
import { test, expect } from "@playwright/test";

test("book two tickets, cancel, see the exact refund amount", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Tickets:").fill("2");
  await page.getByRole("button", { name: "Book tickets" }).click();
  await expect(page.getByText("Paid: 10000 cents")).toBeVisible();
  await page.getByRole("button", { name: "Cancel order" }).click();
  // paid 10000, fee 2% = 200 -> the user must SEE 9800
  await expect(page.getByText("Refunded: 9800 cents")).toBeVisible();
});
