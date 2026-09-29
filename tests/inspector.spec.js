import { test, expect } from "@playwright/test";

// Clicks the on-screen spot of a world position; the canvas may be displayed at a different size than the world.
async function clickWorld(page, x, y) {
  const box = await page.locator("#world").boundingBox();
  const size = await page.evaluate(() => ({ w: window.__world.width, h: window.__world.height }));
  await page.mouse.click(box.x + (x * box.width) / size.w, box.y + (y * box.height) / size.h);
}

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
  const panel = page.locator("#panel-inspector");
  await expect(panel.locator("#inspector-content")).toHaveAttribute("aria-live", "polite");

  await clickWorld(page, 200, 150);
  await expect(panel).toContainText("predator");
  await expect(panel.locator("[data-field=generation]")).toHaveText("3");
  await expect(panel.locator("[data-field=energy]")).toContainText("60.0");
  expect(await page.evaluate(() => window.__selection.id === window.__probe.id)).toBe(true);

  await clickWorld(page, 20, 20);
  await expect(panel.locator("[data-field=species]")).toBeHidden();
  await expect(panel.locator("#inspector-content p")).toHaveText("Click a creature to inspect it.");
  expect(await page.evaluate(() => window.__selection.id)).toBeNull();

  await clickWorld(page, 200, 150);
  await expect(panel).toContainText("predator");
  const id = await page.evaluate(async () => {
    const { removeCreatures } = await import("/static/world-sim.js");
    removeCreatures(window.__world, (c) => c === window.__probe, "plague");
    return window.__probe.id;
  });
  await expect(panel).toContainText(`Creature #${id} died (plague)`);
});

test("a creature dying inside step() is reported, and a throwing overlay does not stop the frame loop", async ({ page }) => {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world);
  await page.evaluate(async () => {
    const { addCreature } = await import("/static/world-sim.js");
    const w = window.__world;
    window.__worldControl.paused = true;
    w.creatures.length = 0;
    w.food.length = 0;
    window.__probe = addCreature(w, { x: 300, y: 200, energy: 0.01, species: "herbivore" });
  });
  await clickWorld(page, 300, 200);
  const panel = page.locator("#panel-inspector");
  await expect(panel.locator("[data-field=species]")).toBeVisible();
  await page.evaluate(() => {
    window.__worldControl.paused = false;
  });
  await expect(panel).toContainText(/Creature #\d+ died \(starved\)/);
  expect(await page.evaluate(() => window.__selection.id)).toBeNull();

  await page.evaluate(() => {
    window.__overlays.push(() => {
      throw new Error("boom");
    });
  });
  const before = await page.evaluate(() => window.__world.time);
  await page.waitForFunction((t) => window.__world.time > t + 0.3, before);
  expect(await page.evaluate(() => window.__overlays.length)).toBeGreaterThan(0);
});
