// One definition of "what the user sees" on the booking page, shared by the
// specs. Role and text based — nothing here reaches for a CSS chain.
import { expect, Page } from "@playwright/test";

export const paidLine = (page: Page) => page.getByText(/^Paid: /);
export const refundLine = (page: Page) => page.getByText(/^Refunded: /);
export const cancelButton = (page: Page) => page.getByRole("button", { name: "Cancel order" });

export interface BookedOrder {
  id: number;
  totalCents: number;
  tickets: number;
  eventStartMs: number;
}

/**
 * Books through the UI and returns the order the server actually created.
 * Reading the real response is how a spec learns the event start without
 * copying constants out of the source.
 */
export async function bookThroughUI(page: Page, tickets: string): Promise<BookedOrder> {
  const booked = page.waitForResponse((r) => r.url().endsWith("/api/book"));
  await page.getByLabel("Tickets:").fill(tickets);
  await page.getByRole("button", { name: "Book tickets" }).click();
  const response = await booked;
  const order = await response.json();
  // A refused booking shows the user an alert and leaves the paid line hidden.
  // Reporting that as "expected visible, received hidden" hides the one fact
  // that explains it, so surface what the server actually said instead.
  if (!response.ok()) {
    throw new Error(
      `booking ${tickets} ticket(s) at ${response.url()} was refused with ${response.status()}: ${JSON.stringify(order)}`,
    );
  }
  await expect(paidLine(page)).toBeVisible();
  return order as BookedOrder;
}

/** Attempts a booking without assuming it succeeds. */
export async function attemptBooking(page: Page, tickets: string) {
  const booked = page.waitForResponse((r) => r.url().endsWith("/api/book"));
  await page.getByLabel("Tickets:").fill(tickets);
  await page.getByRole("button", { name: "Book tickets" }).click();
  await booked;
}

/** Records every alert the page raises. Survives reloads. */
export function collectDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on("dialog", async (d) => {
    seen.push(d.message());
    await d.dismiss();
  });
  return seen;
}

/**
 * A plain-English snapshot of the booking outcome as presented to the user,
 * so a failed expectation reports the screen rather than a boolean.
 */
export async function bookingOutcome(page: Page, dialogs: string[]): Promise<string> {
  if (dialogs.length > 0) return `alert: ${dialogs.join(" | ")}`;
  const paid = paidLine(page);
  if (await paid.isVisible()) return `page shows "${(await paid.textContent())?.trim()}"`;
  return "nothing shown yet";
}
