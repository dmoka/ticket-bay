// Money path 1: a customer books with a discount code and is charged exactly
// what the invoice promised. Assert what the user SEES — the amounts on the
// page, never just "page loaded".
import { test, expect } from "@playwright/test";
import { BOOKING_AT_MS, E2E_EVENTS } from "./support/env";
import { pay, seatsLeft, setClock, ticketsLine, totalLine } from "./support/app";

test("a discount code lowers the price at checkout, and the customer is charged exactly that", async ({ page, context }) => {
  await setClock(context, BOOKING_AT_MS);
  const ev = E2E_EVENTS.discount;
  await page.goto(`/events/${ev}/checkout?qty=2`);
  await page.getByLabel("Discount code").fill("welcome10");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("WELCOME10 applied")).toBeVisible();
  // 2 x €50.00 less 10%, plus the 3% service fee (€2.70).
  await expect(ticketsLine(page)).toHaveText("Tickets €90.00");
  await expect(totalLine(page)).toHaveText("Total €92.70");
  await expect(page.getByRole("button", { name: "Pay €92.70" })).toBeEnabled();

  await pay(page, "coder@example.com");
  await expect(ticketsLine(page)).toHaveText("Tickets €90.00");
  await expect(totalLine(page)).toHaveText("Total paid €92.70");

  await page.goto(`/events/${ev}`);
  await expect(seatsLeft(page), "the two seats are taken").toHaveText("58 / 100");
});
