import { test, expect } from "@playwright/test";

test("legend lists each known species and the canvas draws both shapes", async ({ page }) => {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world && window.__renderStats);
  const entries = page.locator("#legend .legend-entry");
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText("herbivore");
  await expect(entries.nth(1)).toContainText("predator");

  // Paused so predators cannot split or die between adding one and reading the count.
  const predators = await page.evaluate(() => {
    window.__worldControl.paused = true;
    window.__world.creatures.push({
      x: 100, y: 100, heading: 1, turnRate: 0, speed: 0, hue: 200,
      energy: 50, radius: 6, id: 9999, plague: 0, dead: false, generation: 0, age: 0,
      species: "predator",
    });
    return window.__world.creatures.filter((c) => c.species === "predator").length;
  });
  expect(predators).toBeGreaterThan(1);
  await expect.poll(() => page.evaluate(() => window.__renderStats.drawn.predator)).toBe(predators);
  const drawn = await page.evaluate(() => window.__renderStats.drawn);
  expect(drawn.herbivore).toBeGreaterThan(0);
});
