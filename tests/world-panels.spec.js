import { test, expect } from "@playwright/test";

const SLOTS = ["panel-stats", "panel-inspector", "panel-save"];

async function revealSlots(page) {
  await page.evaluate(() => document.querySelectorAll("#panels section").forEach((s) => (s.hidden = false)));
}

test("world page has the three named panel slots and hides them while empty", async ({ page }) => {
  await page.goto("/world");
  for (const id of SLOTS) await expect(page.locator(`#panels > section#${id} > h2`)).toHaveCount(1);
  await expect(page.locator("#panels")).toBeHidden();
  await expect(page.locator("canvas#world")).toBeVisible();
});

test("panels sit beside the canvas at 1200px", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/world");
  await revealSlots(page);
  const canvas = await page.locator("#world").boundingBox();
  const panels = await page.locator("#panels").boundingBox();
  expect(panels.x).toBeGreaterThanOrEqual(canvas.x + canvas.width);
  expect(panels.y).toBeLessThan(canvas.y + canvas.height);
});

test("panels stack under the canvas at 600px", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto("/world");
  await revealSlots(page);
  const canvas = await page.locator("#world").boundingBox();
  const panels = await page.locator("#panels").boundingBox();
  expect(panels.y).toBeGreaterThanOrEqual(canvas.y + canvas.height);
  await expect(page.locator("#world")).toBeVisible();
});
