import { test, expect } from "@playwright/test";

test("a throwing overlay is removed and the other overlays keep drawing", async ({ page }) => {
  await page.goto("/world");
  await page.waitForFunction(() => window.__overlays && window.__world);
  await page.evaluate(() => {
    window.__healthyCalls = 0;
    window.__healthy = () => { window.__healthyCalls++; };
    window.__throwing = () => { throw new Error("boom"); };
    window.__overlays.push(window.__healthy, window.__throwing);
  });
  await page.waitForFunction(() => !window.__overlays.includes(window.__throwing));
  const calls = await page.evaluate(() => window.__healthyCalls);
  await page.waitForFunction((n) => window.__healthyCalls > n + 5, calls);
  expect(await page.evaluate(() => window.__overlays.includes(window.__healthy))).toBe(true);
});

test("an overlay that removes itself and then throws does not take another overlay with it", async ({ page }) => {
  await page.goto("/world");
  await page.waitForFunction(() => window.__overlays && window.__world);
  await page.evaluate(() => {
    window.__healthyCalls = 0;
    window.__healthy = () => { window.__healthyCalls++; };
    window.__selfRemoving = () => {
      window.__overlays.splice(window.__overlays.indexOf(window.__selfRemoving), 1);
      throw new Error("boom after unmount");
    };
    window.__overlays.push(window.__healthy, window.__selfRemoving);
  });
  await page.waitForFunction(() => !window.__overlays.includes(window.__selfRemoving));
  const calls = await page.evaluate(() => window.__healthyCalls);
  await page.waitForFunction((n) => window.__healthyCalls > n + 5, calls);
  expect(await page.evaluate(() => window.__overlays.includes(window.__healthy))).toBe(true);
});
