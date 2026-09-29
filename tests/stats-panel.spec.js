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

  // Zebra line color comes from the shared species color helper.
  const expected = await page.evaluate(async () => {
    const { speciesColor } = await import("/static/render-species.js");
    const probe = document.createElement("canvas").getContext("2d");
    probe.fillStyle = speciesColor("zebras");
    probe.fillRect(0, 0, 1, 1);
    return Array.from(probe.getImageData(0, 0, 1, 1).data);
  });
  await expect
    .poll(() =>
      page.evaluate((rgb) => {
        const c = document.getElementById("pop-chart");
        const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 200 && rgb.every((v, k) => Math.abs(data[i + k] - v) < 12)) return true;
        }
        return false;
      }, expected.slice(0, 3)),
    )
    .toBe(true);
});
