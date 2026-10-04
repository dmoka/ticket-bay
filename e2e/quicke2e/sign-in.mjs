// Signs the seeded demo customer in once and saves the session the specs load (.auth/anna.json).
//   node e2e/quicke2e/sign-in.mjs http://localhost:3000
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:3000";
const out = new URL(".auth/anna.json", import.meta.url).pathname;
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: base });
const page = await context.newPage();
await page.goto("/sign-in?next=%2Forders");
await page.getByLabel("Email").fill("anna@ticketbay.test");
await page.getByLabel("Password").fill("ticketbay-demo");
await page.getByRole("button", { name: "Sign in" }).click();
await page.waitForURL(/\/orders$/);
await context.storageState({ path: out });
await browser.close();
console.log(`saved ${out}`);
