// Settings → Developers: the API key lifecycle an agent's access hangs on.
// A key acts as the customer — it can book and refund with their money — so
// the two promises that matter are: the secret is shown ONCE, and a revoked
// key is gone from the list.
import { test, expect } from "@playwright/test";
import { E2E_USERS } from "./support/env";
import { signIn } from "./support/app";

test("a new API key is shown once, and revoking it removes it from the account", async ({ page }) => {
  await signIn(page, E2E_USERS.developer, "/settings/developers");
  await expect(page.getByRole("heading", { name: "Developers" })).toBeVisible();
  await expect(page.getByText("No API keys yet.")).toBeVisible();

  await page.getByLabel("Key name").fill("Claude Code");
  await page.getByRole("button", { name: "Create key" }).click();

  const fresh = page.getByTestId("new-key");
  await expect(fresh).toContainText("Copy “Claude Code” now — it will not be shown again.");
  const secret = (await page.getByTestId("new-key-value").textContent())!.trim();
  expect(secret, "every TicketBay key carries the tb_ prefix").toMatch(/^tb_\w{20,}$/);

  // The list shows the key by name and a short prefix only — never the secret.
  const row = page.getByTestId("key-row").filter({ hasText: "Claude Code" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(`${secret.slice(0, 8)}…`);
  await expect(row).not.toContainText(secret);

  // Shown once: after a reload the secret is nowhere on the page.
  await page.reload();
  await expect(row).toHaveCount(1);
  await expect(fresh).toBeHidden();
  await expect(page.locator("body")).not.toContainText(secret);

  // Revoke asks for a confirmation, then the key is gone for good.
  await page.getByRole("button", { name: "Revoke Claude Code" }).click();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByText("Key revoked. Agents using it are locked out now.")).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(page.getByText("No API keys yet.")).toBeVisible();

  await page.reload();
  await expect(row, "a revoked key stays revoked after a reload").toHaveCount(0);
});
