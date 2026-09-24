// What the platform keeps, as the customer sees it.
//
// src/domain/refund.ts: "Fee kept by the platform on every refund, in cents.
// Min 50, 2% of refund." and netRefund: "Never negative." At €50.00 a ticket
// the floor never bites, so these specs create cheaper venues.
import { test, expect } from "@playwright/test";
import { bookThroughUI, cancelOnPage, freshVenue, refundLine, seatsLeft, ticketsLine } from "./support/app";

test("on a small order the customer is charged the 50-cent floor, not 2%", async ({ page }) => {
  const ev = freshVenue({ priceCents: 1000 });
  await bookThroughUI(page, ev, "2");
  await expect(ticketsLine(page)).toHaveText("Tickets €20.00");
  await cancelOnPage(page);
  // 2% of €20.00 is €0.40, under the minimum, so the fee is €0.50: €19.50 back, not €19.60.
  await expect(refundLine(page), "the minimum fee must be applied, not the 2% rate").toHaveText("Refunded €19.50");
});

test("a refund smaller than the fee shows zero back, never a negative amount", async ({ page }) => {
  const ev = freshVenue({ priceCents: 10 });
  await bookThroughUI(page, ev, "1");
  await expect(ticketsLine(page)).toHaveText("Tickets €0.10");
  await cancelOnPage(page);
  await expect(refundLine(page), "net refund must be floored at zero, never negative").toHaveText("Refunded €0.00");
});

test("a cancellation entirely swallowed by the fee still puts the seat back on sale", async ({ page }) => {
  // The seat return is gated on the CLOCK, not on the refund amount: the
  // customer got €0.00 back but cancelled in time, so the seat is for sale again.
  const ev = freshVenue({ priceCents: 10, totalSeats: 1, seatsSold: 0 });
  await bookThroughUI(page, ev, "1");
  await cancelOnPage(page);
  await expect(refundLine(page)).toHaveText("Refunded €0.00");
  await page.goto(`/events/${ev.id}`);
  await expect(seatsLeft(page), "a zero-value refund is still a cancellation").toHaveText("1 / 1");
});
