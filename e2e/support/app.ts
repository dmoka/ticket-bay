// Test harness helpers — NOT application code.
//
// Specs create their own event straight in the app's SQLite file, so every
// spec starts from a pristine venue with known seats and price, and parallel
// workers never share inventory. Everything the browser touches is the real
// app: real pages, real server actions, real domain modules.
import { randomUUID } from "node:crypto";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { openDb, type Db } from "../../src/db/client";
import { createEvent } from "../../src/db/events-repo";
import { discountCodes } from "../../src/db/schema";
import type { EventRow } from "../../src/db/schema";
import { E2E_DATABASE, E2E_PORT } from "./env";

const DAY = 86_400_000;
let db: Db | undefined;

/**
 * The old demo venue: 100 seats, 40 already sold (60 left), €50.00 a ticket,
 * ten days out — inside the refund window, outside the early-bird one.
 */
export function freshVenue(over: Partial<{ priceCents: number; totalSeats: number; seatsSold: number; startsAtMs: number }> = {}): EventRow {
  db ??= openDb(E2E_DATABASE);
  const id = `e2e-${randomUUID().slice(0, 8)}`;
  return createEvent(db, {
    id,
    name: `RockFest ${id.slice(4)}`,
    category: "concert",
    venue: "Test Arena",
    city: "Budapest",
    description: "Created by the Playwright suite.",
    startsAtMs: over.startsAtMs ?? Date.now() + 10 * DAY,
    totalSeats: over.totalSeats ?? 100,
    seatsSold: over.seatsSold ?? 40,
    priceCents: over.priceCents ?? 5000,
    createdAtMs: Date.now(),
  });
}

/** Makes sure a discount code exists (the e2e database is migrated, not seeded). */
export function ensureCode(code: string, percent: number) {
  db ??= openDb(E2E_DATABASE);
  db.insert(discountCodes).values({ code, percent, createdAtMs: Date.now() }).onConflictDoNothing().run();
}

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

/** Opens checkout for `qty` tickets the way a customer does: from the event page. */
export async function startCheckout(page: Page, ev: EventRow, qty: string) {
  await page.goto(`/events/${ev.id}`);
  await page.getByLabel("Tickets").fill(qty);
  await page.getByRole("button", { name: "Continue to checkout" }).click();
  await page.waitForURL(/\/checkout\?/);
}

/** Books through the UI and lands on the confirmation page. Returns the order id. */
export async function bookThroughUI(page: Page, ev: EventRow, qty: string, email = "fan@example.com"): Promise<number> {
  await startCheckout(page, ev, qty);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Name on tickets").fill("A Fan");
  await page.getByRole("button", { name: /^Pay / }).click();
  // A refused booking stays on checkout with an alert. Report what it said
  // instead of timing out on a URL that will never come.
  const outcome = await Promise.race([
    page.waitForURL(/\/orders\/\d+\?placed=1/).then(() => "ok"),
    checkoutError(page).waitFor().then(async () => `refused: ${await checkoutError(page).textContent()}`),
  ]);
  if (outcome !== "ok") throw new Error(`booking ${qty} ticket(s) for ${ev.id} was ${outcome}`);
  await expect(page.getByText("Payment confirmed")).toBeVisible();
  return Number(/\/orders\/(\d+)/.exec(page.url())![1]);
}

/** Cancels the order on the page and waits until the refund is shown. */
export async function cancelOnPage(page: Page) {
  await cancelButton(page).click();
  await expect(refundLine(page)).toBeVisible();
}
