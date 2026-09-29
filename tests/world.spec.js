import { test, expect } from "@playwright/test";

test("world page shows a canvas with 20 herbivores and 3 predators wandering", async ({ page }) => {
  await page.goto("/world?seed=1&paused=1");
  await expect(page.locator("canvas#world")).toBeVisible();
  await page.waitForFunction(() => window.__world);
  expect(await page.evaluate(() => window.__world.creatures.length)).toBe(23);
  await page.evaluate(() => { window.__worldControl.paused = false; });
  const before = await page.evaluate(() => window.__world.creatures.map((c) => [c.x, c.y]));
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.__world.creatures.map((c) => [c.x, c.y]));
  expect(after).not.toEqual(before);
});

test("creatures stay inside the canvas after resize", async ({ page }) => {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world);
  await page.setViewportSize({ width: 400, height: 500 });
  await page.waitForTimeout(300);
  const inside = await page.evaluate(() =>
    window.__world.creatures.every((c) => c.x >= 0 && c.x <= window.__world.width && c.y >= 0 && c.y <= window.__world.height),
  );
  expect(inside).toBe(true);
});

test("home page links to the world page", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator("#greeting")).toBeVisible();
  await page.locator("#world-link").click();
  await expect(page).toHaveURL(/\/world$/);
  const js = await request.get("/static/world.js");
  expect(js.headers()["content-type"]).toContain("text/javascript");
});
