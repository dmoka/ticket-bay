// The edges of the ticket field, as a real user can drive it.
//
// `bookTickets` refuses an order whose gross exceeds Number.MAX_SAFE_INTEGER
// so the refund path is never handed a total it refuses. That guard sits AFTER
// the capacity check, which keeps it off every route a customer can reach on a
// normally priced event: these specs pin that ordering as the customer sees it.
import { test, expect } from "@playwright/test";
import { bookThroughUI, checkoutError, freshVenue, seatsLeft, startCheckout, ticketsLine } from "./support/app";

test("the last seat in the venue is bookable, and one more than that is refused", async ({ page }) => {
  const ev = freshVenue();
  await startCheckout(page, ev, "61");
  await expect(checkoutError(page)).toHaveText("Not enough seats — only 60 left.");

  await bookThroughUI(page, ev, "60");
  // 60 x €50.00 less the 10% group tier.
  await expect(ticketsLine(page)).toHaveText("Tickets €2,700.00");
  await page.goto(`/events/${ev.id}`);
  await expect(seatsLeft(page)).toHaveText("0 / 100");
});

test("a ticket count far beyond the venue reads as a capacity problem, not an arithmetic one", async ({ page }) => {
  const ev = freshVenue();
  for (const typed of ["1e21", "9007199254740993", "999999999999999999999999"]) {
    await page.goto(`/events/${ev.id}/checkout?qty=${typed}`);
    await expect(checkoutError(page), `typing ${typed} should read as a capacity problem`).toHaveText(/not enough seats/i);
    await expect(checkoutError(page)).not.toContainText("out of range");
  }
});

test("zero, negative and fractional ticket counts are refused with a plain message", async ({ page }) => {
  const ev = freshVenue();
  for (const typed of ["0", "-2", "1.5"]) {
    await page.goto(`/events/${ev.id}/checkout?qty=${typed}`);
    await expect(checkoutError(page)).toHaveText("Choose at least one ticket.");
    await expect(page.getByRole("button", { name: /^Pay/ })).toBeDisabled();
  }
});

test("an order too large for the refund path is refused before the customer pays", async ({ page }) => {
  const ev = freshVenue({ priceCents: Number.MAX_SAFE_INTEGER });
  await page.goto(`/events/${ev.id}/checkout?qty=2`);
  await expect(checkoutError(page)).toHaveText("Cannot book this order: order total out of range.");
  await expect(page.getByRole("button", { name: /^Pay/ })).toBeDisabled();
});
