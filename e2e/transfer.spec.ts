// Ticket transfer: the owner gives a paid order to a friend's account, and
// the order moves from the owner's My orders to the friend's.
import { test, expect } from "@playwright/test";
import { orderNumber } from "../lib/format";
import { BOOKING_AT_MS, E2E_BASE_URL, E2E_EVENTS, E2E_USERS } from "./support/env";
import { bookThroughUI, setClock, signIn } from "./support/app";

test("the owner transfers an order before the event and the friend sees it in My orders", async ({ page, context, browser }) => {
  const owner = E2E_USERS.transferOwner;
  const friend = E2E_USERS.transferFriend;
  await setClock(context, BOOKING_AT_MS);
  await signIn(page, owner);
  const orderId = await bookThroughUI(page, owner, E2E_EVENTS.transfer, "2");

  await page.getByLabel("Friend's email").fill(friend.email);
  await page.getByRole("button", { name: "Transfer" }).click();
  await page.waitForURL("/orders");
  await expect(page.getByText(orderNumber(orderId))).toBeHidden();

  const friendContext = await browser.newContext({ baseURL: E2E_BASE_URL });
  const friendPage = await friendContext.newPage();
  await setClock(friendContext, BOOKING_AT_MS);
  await signIn(friendPage, friend);
  await friendPage.goto("/orders");
  await expect(friendPage.getByText(orderNumber(orderId))).toBeVisible();
  await friendContext.close();
});
