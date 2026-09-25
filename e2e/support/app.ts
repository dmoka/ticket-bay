// Test harness helpers — NOT application code.
//
// The specs drive the real app only through the browser: real pages, real
// server actions, real domain modules, real Postgres. Their data is the fixed
// e2e seed (seed.ts); their "now" is a cookie the server honors under
// TICKETBAY_TEST_CLOCK=1 (lib/clock.ts).
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { E2E_PASSWORD, E2E_PORT, type E2EUser } from "./env";

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

let clients = 0;
/**
 * Better Auth rate-limits sign-in per client IP (3 per 10 s in production). A
 * whole parallel suite on 127.0.0.1 would look like one client hammering the
 * form, so each signing-in browser gets its own address, like real customers.
 */
function clientIp(): string {
  clients += 1;
  return `10.${process.pid % 250}.${Math.floor(clients / 250) % 250}.${(clients % 250) + 1}`;
}

/**
 * Fills in the sign-in form the page is showing and submits it. Better Auth
 * sets the session cookie on this browser context; the form then sends the
 * browser on to `next`.
 */
export async function submitSignIn(page: Page, user: E2EUser) {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.setExtraHTTPHeaders({ "x-forwarded-for": clientIp() });
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** Signs in through the real /sign-in page and waits until the browser is back on `next`. */
export async function signIn(page: Page, user: E2EUser, next = "/") {
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
  await submitSignIn(page, user);
  await page.waitForURL((u) => u.pathname + u.search === next);
}

/**
 * Pays as the signed-in account; lands on the confirmation page. Returns the
 * order id. Tickets always go to the account email — checkout shows it, it is
 * not a field the customer fills in any more.
 */
export async function pay(page: Page, user: E2EUser): Promise<number> {
  await expect(page.getByLabel("Email"), "tickets go to the signed-in account").toHaveValue(user.email);
  await page.getByLabel("Name on tickets").fill(user.name);
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

/** Books `qty` tickets the way a signed-in customer does: from the event page, through checkout. */
export async function bookThroughUI(page: Page, user: E2EUser, eventId: string, qty: string): Promise<number> {
  await page.goto(`/events/${eventId}`);
  await page.getByLabel("Tickets").fill(qty);
  await page.getByRole("button", { name: "Continue to checkout" }).click();
  await page.waitForURL(/\/checkout\?/);
  return pay(page, user);
}

/** Cancels the order on the page and waits until the refund is shown. */
export async function cancelOnPage(page: Page) {
  await cancelButton(page).click();
  await expect(refundLine(page)).toBeVisible();
}
