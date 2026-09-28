import { test, expect } from "@playwright/test";

test("home page greets the world", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#greeting")).toHaveText("Hello, world!");
});
