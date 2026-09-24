// Captures the reference screenshots of a running app (npm run dev + seeded DB).
//   npm run screenshots -- <out-dir>        BASE_URL defaults to http://localhost:3000
// Places one real order through the UI (for the confirmation shot).
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OUT = path.resolve(process.argv[2] ?? "screenshots");
fs.mkdirSync(OUT, { recursive: true });

async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  console.log(`  ${name}.png`);
}

const browser = await chromium.launch();
const light = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
const page = await light.newPage();

await page.goto(`${BASE}/`);
await shot(page, "01-events");

await page.goto(`${BASE}/events/craftconf-agents-in-production`);
await shot(page, "02-event");

await page.goto(`${BASE}/events/craftconf-agents-in-production/checkout?qty=5&code=WELCOME10`);
await shot(page, "03-checkout");

await page.getByLabel("Email").fill("jordan.lee@example.com");
await page.getByLabel("Name on tickets").fill("Jordan Lee");
await page.getByRole("button", { name: /^Pay / }).click();
await page.waitForURL(/\/orders\/\d+\?placed=1/);
await shot(page, "04-confirmation");

await page.goto(`${BASE}/orders?email=alex.morgan@example.com`);
await shot(page, "05-my-orders");

await page.goto(`${BASE}/admin`);
await shot(page, "06-admin-overview");

await page.goto(`${BASE}/admin/orders`);
await page.locator("tbody tr").nth(2).click();
await page.getByRole("dialog").waitFor();
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, "07-admin-orders-peek.png") });
console.log("  07-admin-orders-peek.png");

for (const [route, name] of [
  ["/admin/events", "08-admin-events"],
  ["/admin/refunds", "09-admin-refunds"],
  ["/admin/codes", "10-admin-codes"],
] as const) {
  await page.goto(`${BASE}${route}`);
  await shot(page, name);
}

const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
await dark.addInitScript(() => localStorage.setItem("theme", "dark"));
const darkPage = await dark.newPage();
await darkPage.goto(`${BASE}/admin`);
await shot(darkPage, "11-admin-overview-dark");

await browser.close();
console.log(`saved to ${OUT}`);
