// The money path, through a real browser. Assert what the user SEES — the
// amounts rendered on the page, never just "page loaded".
import { test, expect } from "@playwright/test";
import { bookThroughUI, cancelButton, cancelOnPage, freshVenue, refundLine, ticketsLine, totalLine } from "./support/app";

test("book two tickets, cancel, see the exact refund amount", async ({ page }) => {
  const ev = freshVenue();
  await bookThroughUI(page, ev, "2");

  // 2 x €50.00, no discount; the 3% service fee (€3.00) is on top.
  await expect(ticketsLine(page)).toHaveText("Tickets €100.00");
  await expect(totalLine(page)).toHaveText("Total paid €103.00");

  await cancelOnPage(page);
  // Refund is on the €100.00 paid for tickets, less the 2% fee (€2.00): the user must SEE €98.00.
  await expect(refundLine(page)).toHaveText("Refunded €98.00");
  await expect(cancelButton(page)).toBeHidden();
});

test("the checkout shows the invoice line by line before the customer pays", async ({ page }) => {
  const ev = freshVenue();
  await page.goto(`/events/${ev.id}/checkout?qty=5`);
  await expect(page.getByTestId("line-subtotal")).toHaveText("5 × €50.00 €250.00");
  await expect(page.getByTestId("line-discount")).toContainText("−€12.50");
  await expect(page.getByTestId("line-discount")).toContainText("group 5%");
  await expect(ticketsLine(page)).toHaveText("Tickets €237.50");
  await expect(page.getByTestId("line-fee")).toHaveText("Service fee €7.13");
  await expect(totalLine(page)).toHaveText("Total €244.63");
  await expect(page.getByTestId("line-vat")).toHaveText("incl. VAT 27% €52.01");
  await expect(page.getByRole("button", { name: "Pay €244.63" })).toBeEnabled();
});
