// The money path, through a real browser. Assert what the user SEES —
// the refund amount rendered on the page, never just "page loaded".
//
// Its own server (support/harness.ts) rather than the shared one on 4173: that
// server holds the venue in module-level state, and this spec used to share it
// with refund-money-paths.spec.ts running in a parallel worker. See the note at
// the top of that file.
import { test, expect } from "@playwright/test";
import { startClockServer, ClockServer } from "./support/harness";

const running: ClockServer[] = [];

test.afterEach(() => {
  while (running.length) running.pop()!.stop();
});

test("book two tickets, cancel, see the exact refund amount", async ({ page }) => {
  const server = await startClockServer();
  running.push(server);

  await page.goto(server.url);
  await page.getByLabel("Tickets:").fill("2");
  await page.getByRole("button", { name: "Book tickets" }).click();
  await expect(page.getByText("Paid: 10000 cents")).toBeVisible();
  await page.getByRole("button", { name: "Cancel order" }).click();
  // paid 10000, fee 2% = 200 -> the user must SEE 9800
  await expect(page.getByText("Refunded: 9800 cents")).toBeVisible();
});
