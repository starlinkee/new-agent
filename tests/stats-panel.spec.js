import { test, expect } from "@playwright/test";

test("population chart panel shows species summary and draws lines", async ({ page }) => {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world && window.__stats);
  await expect(page.locator("#panel-stats #pop-chart")).toHaveCount(1);
  await expect(page.locator("#pop-summary")).toContainText("Food");

  await page.evaluate(async () => {
    const { addCreature } = await import("/static/world-sim.js");
    for (let i = 0; i < 6; i++) addCreature(window.__world, { species: "zebras", hue: 200 });
  });
  await expect(page.locator("#pop-summary")).toContainText(/zebras [1-9]/, { timeout: 10000 });

  // Zebra line color is hsl(200 80% 60%) = rgb(61,173,235); sample inside the plot, away from the border.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const c = document.getElementById("pop-chart");
        const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 200 && Math.abs(data[i] - 61) < 12 && Math.abs(data[i + 1] - 173) < 12 && Math.abs(data[i + 2] - 235) < 12) return true;
        }
        return false;
      }),
    )
    .toBe(true);
});
