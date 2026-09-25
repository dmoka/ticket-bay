// Settings → Developers: the API key lifecycle an agent's access hangs on.
// A read & write key acts as the customer — it can book and refund with their
// money — so the promises that matter are: the secret is shown ONCE, the scope
// on the key is the one the customer picked (Read only is the default), a
// rotated key keeps its scope, and a revoked key is gone from the list.
import { test, expect, type Page } from "@playwright/test";
import { E2E_USERS } from "./support/env";
import { signIn } from "./support/app";

const keyRow = (page: Page, name: string) => page.getByTestId("key-row").filter({ hasText: name });

/** Creates a key through the form and returns the secret it shows once. */
async function createKey(page: Page, name: string, scope?: "Read only" | "Read & write"): Promise<string> {
  await page.getByLabel("Key name").fill(name);
  if (scope) await page.getByLabel("Key scope").selectOption({ label: scope });
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByTestId("new-key")).toContainText(`Copy “${name}” now — it will not be shown again.`);
  const secret = (await page.getByTestId("new-key-value").textContent())!.trim();
  expect(secret, "every TicketBay key carries the tb_ prefix").toMatch(/^tb_\w{20,}$/);
  await expect(keyRow(page, name)).toHaveCount(1);
  return secret;
}

test("API keys: shown once, scoped as chosen, rotate keeps the scope, revoke removes the key", async ({ page }) => {
  await signIn(page, E2E_USERS.developer, "/settings/developers");
  await expect(page.getByRole("heading", { name: "Developers" })).toBeVisible();
  await expect(page.getByText("No API keys yet.")).toBeVisible();
  await expect(page.getByLabel("Key scope"), "the safe scope is the default").toHaveValue("read");

  // Default scope: Read only.
  const readSecret = await createKey(page, "Research agent");
  const readRow = keyRow(page, "Research agent");
  await expect(readRow.getByTestId("key-scope")).toHaveText("Read only");
  // The list shows the key by name and a short prefix only — never the secret.
  await expect(readRow).toContainText(`${readSecret.slice(0, 8)}…`);
  await expect(readRow).not.toContainText(readSecret);

  // Explicitly Read & write.
  const writeSecret = await createKey(page, "Booking agent", "Read & write");
  await expect(keyRow(page, "Booking agent").getByTestId("key-scope")).toHaveText("Read & write");
  await expect(readRow.getByTestId("key-scope"), "creating a second key leaves the first one's scope alone").toHaveText("Read only");

  // Shown once: after a reload neither secret is anywhere on the page.
  await page.reload();
  await expect(page.getByTestId("key-row")).toHaveCount(2);
  await expect(page.getByTestId("new-key")).toBeHidden();
  await expect(page.locator("body")).not.toContainText(readSecret);
  await expect(page.locator("body")).not.toContainText(writeSecret);

  // Rotate the read-only key: a new secret, the SAME scope — a rotation must
  // never quietly turn a read-only agent into one that can spend money.
  await page.getByRole("button", { name: "Rotate Research agent" }).click();
  await page.getByRole("button", { name: "Rotate — old key stops working" }).click();
  await expect(page.getByText("Key rotated. The old secret stopped working.")).toBeVisible();
  await expect(page.getByTestId("new-key")).toContainText("Copy “Research agent” now");
  const rotated = (await page.getByTestId("new-key-value").textContent())!.trim();
  expect(rotated).toMatch(/^tb_\w{20,}$/);
  expect(rotated, "rotation issues a new secret").not.toBe(readSecret);
  await expect(readRow).toHaveCount(1);
  await expect(readRow.getByTestId("key-scope")).toHaveText("Read only");
  await expect(readRow).toContainText(`${rotated.slice(0, 8)}…`);
  await page.reload();
  await expect(readRow.getByTestId("key-scope"), "the scope survives a reload after rotation").toHaveText("Read only");
  await expect(keyRow(page, "Booking agent").getByTestId("key-scope")).toHaveText("Read & write");

  // Revoke asks for a confirmation, then the key is gone for good.
  await page.getByRole("button", { name: "Revoke Booking agent" }).click();
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByText("Key revoked. Agents using it are locked out now.")).toBeVisible();
  await expect(keyRow(page, "Booking agent")).toHaveCount(0);
  await expect(readRow).toHaveCount(1);

  await page.reload();
  await expect(keyRow(page, "Booking agent"), "a revoked key stays revoked after a reload").toHaveCount(0);
  await expect(page.getByTestId("key-row")).toHaveCount(1);
});
