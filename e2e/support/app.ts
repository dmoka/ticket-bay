// Test harness helpers — NOT application code.
//
// The specs drive the real app only through the browser: real pages, real
// server actions, real domain modules, real Postgres. Their data is the fixed
// e2e seed (seed.ts); their "now" is a cookie the server honors under
// TICKETBAY_TEST_CLOCK=1 (lib/clock.ts).
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { E2E_PORT } from "./env";

/** Serve this browser context as of `ms`. Other contexts keep the real clock. */
export async function setClock(context: BrowserContext, ms: number) {
  await context.addCookies([{ name: "tb-test-now", value: String(ms), url: `http://localhost:${E2E_PORT}` }]);
}

export const ticketsLine = (page: Page) => page.getByTestId("line-tickets");
export const totalLine = (page: Page) => page.getByTestId("line-total");
export const refundLine = (page: Page) => page.getByTestId("refund-line");
export const cancelButton = (page: Page) => page.getByRole("button", { name: "Cancel order" });
export const seatsLeft = (page: Page) => page.getByTestId("seats-left");
// Not getByRole("alert"): Next.js mounts an empty route announcer with that role.
export const checkoutError = (page: Page) => page.getByTestId("checkout-error");

/** Fills in the customer and pays; lands on the confirmation page. Returns the order id. */
export async function pay(page: Page, email = "fan@example.com"): Promise<number> {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Name on tickets").fill("A Fan");
  await page.getByRole("button", { name: /^Pay / }).click();
  // A refused booking stays on checkout with an alert. Report what it said
  // instead of timing out on a URL that will never come.
  const outcome = await Promise.race([
    page.waitForURL(/\/orders\/\d+\?placed=1/).then(() => "ok"),
    checkoutError(page).waitFor().then(async () => `refused: ${await checkoutError(page).textContent()}`),
  ]);
  if (outcome !== "ok") throw new Error(`booking was ${outcome}`);
  await expect(page.getByText("Payment confirmed")).toBeVisible();
  return Number(/\/orders\/(\d+)/.exec(page.url())![1]);
}

/** Books `qty` tickets the way a customer does: from the event page, through checkout. */
export async function bookThroughUI(page: Page, eventId: string, qty: string): Promise<number> {
  await page.goto(`/events/${eventId}`);
  await page.getByLabel("Tickets").fill(qty);
  await page.getByRole("button", { name: "Continue to checkout" }).click();
  await page.waitForURL(/\/checkout\?/);
  return pay(page);
}

/** Cancels the order on the page and waits until the refund is shown. */
export async function cancelOnPage(page: Page) {
  await cancelButton(page).click();
  await expect(refundLine(page)).toBeVisible();
}
