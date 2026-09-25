// Money path 4: the organiser calls an event off. The cancel_event MCP tool
// only PREPARES this — it hands the admin a deep link, /admin/events/<id>/cancel,
// and a human confirms in the UI. Every paid order must then show a FULL
// refund of the ticket price (no refund fee, no window) to its customer.
import { test, expect, type Browser, type Page } from "@playwright/test";
import { BOOKING_AT_MS, E2E_EVENTS, E2E_USERS, type E2EUser } from "./support/env";
import { bookThroughUI, cancelButton, refundLine, setClock, signIn, submitSignIn } from "./support/app";

/** A fresh browser — its own cookies, so its own account — booking at the fixed instant. */
async function customerBooks(browser: Browser, user: E2EUser, qty: string): Promise<{ page: Page; orderId: number }> {
  const context = await browser.newContext();
  await setClock(context, BOOKING_AT_MS);
  const page = await context.newPage();
  await signIn(page, user);
  const orderId = await bookThroughUI(page, user, E2E_EVENTS.adminCancel, qty);
  return { page, orderId };
}

test("an admin cancels an event from the deep link, and every customer sees a full ticket refund", async ({ browser, page, context }) => {
  const ev = E2E_EVENTS.adminCancel;
  // What the cancel_event MCP tool hands the admin: the event's cancel page.
  const deepLink = `/admin/events/${ev}/cancel?via=mcp`;

  // Two customers on two accounts: 2 tickets (€103.00 paid) and 1 ticket (€51.50 paid).
  const ann = await customerBooks(browser, E2E_USERS.fanA, "2");
  const bob = await customerBooks(browser, E2E_USERS.fanB, "1");

  // A customer following the link gets no cancel form and no power.
  await ann.page.goto(deepLink);
  await expect(ann.page.getByRole("heading", { name: "Admins only" })).toBeVisible();
  await expect(ann.page.getByRole("button", { name: "Cancel event and refund everyone" })).toHaveCount(0);

  // The admin opens the deep link signed out: sign-in must bring them back to
  // the SAME link, ?via=mcp included, or the agent's hand-off is lost.
  await setClock(context, BOOKING_AT_MS);
  await page.goto(deepLink);
  await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(deepLink)}`);
  await submitSignIn(page, E2E_USERS.admin);
  await page.waitForURL(deepLink);

  await expect(page.getByRole("heading", { name: "Cancel RockFest admin-cancel?" })).toBeVisible();
  await expect(page.getByText("An AI agent prepared this. Nothing has changed yet — you decide.")).toBeVisible();
  // The impact before anything changes: 2 orders, 3 tickets, €150.00 of tickets back.
  const main = page.getByRole("main");
  await expect(main).toContainText("2 paid orders, 3 tickets, are refunded");
  await expect(main).toContainText("€150.00 goes back to customers");

  // A wrong confirmation changes nothing.
  await page.getByLabel(`Type ${ev} to confirm`).fill("e2e-wrong");
  await page.getByRole("button", { name: "Cancel event and refund everyone" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Type the event id" })).toHaveText("Type the event id exactly to confirm.");
  await expect(page).toHaveURL(deepLink);

  await page.getByLabel(`Type ${ev} to confirm`).fill(ev);
  await page.getByRole("button", { name: "Cancel event and refund everyone" }).click();
  // The admin lands back on the events list with the result as a banner.
  await page.waitForURL(`/admin/events?cancelled=${ev}`);
  await expect(page.getByRole("status").filter({ hasText: "RockFest admin-cancel is cancelled." })).toHaveText(
    "RockFest admin-cancel is cancelled. Sales are closed and 2 orders are refunded, €150.00 in total.",
  );
  // Every refund reached the payment provider: nothing is left to retry.
  await expect(page.getByRole("button", { name: "Retry refunds" })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "RockFest admin-cancel" })).toContainText("Cancelled");

  // The deep link cannot cancel (and refund) twice.
  await page.goto(deepLink);
  await expect(page.getByRole("status")).toContainText("This event is already cancelled.");
  await expect(page.getByRole("button", { name: "Cancel event and refund everyone" })).toHaveCount(0);

  // Each customer: "My orders" says Refunded, and the order page shows the
  // whole ticket price back — €100.00 and €50.00, no 2% fee taken.
  for (const [who, expected] of [
    [ann, "Refunded €100.00"],
    [bob, "Refunded €50.00"],
  ] as const) {
    await who.page.goto("/orders");
    const row = who.page.getByRole("row").filter({ hasText: "RockFest admin-cancel" });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Refunded");

    await who.page.goto(`/orders/${who.orderId}`);
    await expect(refundLine(who.page)).toHaveText(expected);
    await expect(cancelButton(who.page), "no second payout after the event refund").toBeHidden();
  }

  // Sales are closed for everyone.
  await page.goto(`/events/${ev}`);
  await expect(page.getByText("This event has been cancelled.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to checkout" })).toHaveCount(0);

  await ann.page.context().close();
  await bob.page.context().close();
});
