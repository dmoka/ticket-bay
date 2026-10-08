// A new customer's first visit: create an account on the real sign-up page,
// book one ticket, and find the order in My orders. The account is new on
// every run (a fresh email), so it is not in the seed.
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { BOOKING_AT_MS, E2E_EVENTS, E2E_PASSWORD, type E2EUser } from "./support/env";
import { bookThroughUI, setClock, totalLine } from "./support/app";

test("a new customer signs up, books one ticket and sees it in My orders", async ({ page, context }) => {
  await setClock(context, BOOKING_AT_MS);
  const customer: E2EUser = { name: "Nora New", email: `new-${randomUUID()}@e2e.test` };

  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await page.getByLabel("Name").fill(customer.name);
  await page.getByLabel("Email").fill(customer.email);
  await page.getByLabel("Password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  // Sign-up signs the customer in and sends them home; let the home page's
  // event prefetches finish before navigating on (see signIn in support/app.ts).
  await page.waitForURL("/");
  await page.waitForLoadState("networkidle");

  const orderId = await bookThroughUI(page, customer, E2E_EVENTS.signUpAndBook, "1");
  // €50.00 plus the 3% service fee.
  await expect(totalLine(page)).toHaveText("Total paid €51.50");

  // The site header's link: the confirmation page has a "My orders" breadcrumb too.
  await page.getByRole("banner").getByRole("link", { name: "My orders" }).click();
  await expect(page.getByRole("heading", { name: "My orders" })).toBeVisible();
  await expect(page.getByText(`1 order for ${customer.email}`)).toBeVisible();
  const order = page.getByRole("row").filter({
    has: page.getByRole("link", { name: `TB-${String(orderId).padStart(5, "0")}` }),
  });
  await expect(order.getByRole("cell", { name: "First Booking Night" })).toBeVisible();
  await expect(order.getByRole("cell").nth(3), "the Tickets column").toHaveText("1");
});
