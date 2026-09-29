import { test, expect } from "@playwright/test";

test("clicking a creature shows its details, empty space clears, death is reported", async ({ page }) => {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world);
  await page.evaluate(async () => {
    const { addCreature } = await import("/static/world-sim.js");
    const w = window.__world;
    window.__worldControl.paused = true;
    w.creatures.length = 0;
    w.food.length = 0;
    window.__probe = addCreature(w, { x: 200, y: 150, species: "predator", generation: 3, energy: 60 });
  });
  const box = await page.locator("#world").boundingBox();
  const panel = page.locator("#panel-inspector");
  await expect(panel.locator("#inspector-content")).toHaveAttribute("aria-live", "polite");

  await page.mouse.click(box.x + 200, box.y + 150);
  await expect(panel).toContainText("predator");
  await expect(panel.locator("[data-field=generation]")).toHaveText("3");
  await expect(panel.locator("[data-field=energy]")).toContainText("60.0");
  expect(await page.evaluate(() => window.__world.selectedId === window.__probe.id)).toBe(true);

  await page.mouse.click(box.x + 600, box.y + 400);
  await expect(panel.locator("[data-field=species]")).toBeHidden();
  await expect(panel.locator("#inspector-content p")).toHaveText("Click a creature to inspect it.");
  expect(await page.evaluate(() => window.__world.selectedId)).toBeNull();

  await page.mouse.click(box.x + 200, box.y + 150);
  await expect(panel).toContainText("predator");
  const id = await page.evaluate(async () => {
    const { removeCreatures } = await import("/static/world-sim.js");
    removeCreatures(window.__world, (c) => c === window.__probe, "plague");
    return window.__probe.id;
  });
  await expect(panel).toContainText(`Creature #${id} died (plague)`);
});
