import { test, expect } from "@playwright/test";
import { BOOKING_AT_MS, E2E_EVENTS, E2E_USERS } from "./support/env";
import { setClock, signIn, totalLine } from "./support/app";

test("a customer books two tickets and pays", async ({ page, context }) => {
  await setClock(context, BOOKING_AT_MS);
  await signIn(page, E2E_USERS.bookAndPay);

  await page.goto(`/events/${E2E_EVENTS.bookAndPay}`);
  await page.getByLabel("Tickets").fill("2");
  await page.getByRole("button", { name: "Continue to checkout" }).click();

  await page.getByLabel("Name on tickets").fill("Anna Fan");
  await page.getByRole("button", { name: "Pay €103.00" }).click();

  await expect(page.getByText("Payment confirmed")).toBeVisible();
  await expect(totalLine(page)).toHaveText("Total paid €103.00");

  await page.goto("/orders");
  await expect(page.getByText("Book and Pay Night")).toBeVisible();
});
