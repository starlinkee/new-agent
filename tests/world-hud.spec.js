import { test, expect } from "@playwright/test";

const positions = (page) => page.evaluate(() => window.__world.creatures.map((c) => [c.x, c.y]));
const count = async (page, id) => Number(await page.locator(`#${id}`).textContent());

test.beforeEach(async ({ page }) => {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world && window.__worldControl);
});

test("pause stops position changes and resume restarts them", async ({ page }) => {
  await page.locator("#pause").click();
  await expect(page.locator("#pause")).toHaveText("Resume");
  const paused = await positions(page);
  await page.waitForTimeout(400);
  expect(await positions(page)).toEqual(paused);

  await page.locator("#pause").click();
  await expect(page.locator("#pause")).toHaveText("Pause");
  await page.waitForTimeout(400);
  expect(await positions(page)).not.toEqual(paused);
});

test("speed buttons change the simulation rate", async ({ page }) => {
  await page.locator('button[data-speed="4"]').click();
  expect(await page.evaluate(() => window.__worldControl.speed)).toBe(4);
  await expect(page.locator('button[data-speed="4"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('button[data-speed="1"]').click();
  expect(await page.evaluate(() => window.__worldControl.speed)).toBe(1);
});

test("HUD shows live counts", async ({ page }) => {
  await page.locator("#pause").click();
  // The world runs until the click lands, so a split or death may already have happened:
  // compare against the paused world rather than the initial 23 creatures / generation 0.
  const { pop, gen, food } = await page.evaluate(() => {
    const w = window.__world;
    return {
      pop: w.creatures.length,
      gen: Math.max(0, ...w.creatures.map((c) => c.generation)),
      food: w.food.length,
    };
  });
  await expect(page.locator("#pop-count")).toHaveText(String(pop));
  await expect(page.locator("#max-gen")).toHaveText(String(gen));
  await expect(page.locator("#food-count")).toHaveText(String(food));
});

test("click on empty space adds food", async ({ page }) => {
  await page.locator("#pause").click();
  await page.evaluate(() => {
    window.__world.creatures.length = 0;
  });
  const before = await count(page, "food-count");
  await page.locator("#world").click({ position: { x: 50, y: 50 } });
  await expect.poll(() => count(page, "food-count")).toBeGreaterThan(before);
});

test("shift+click spawns a creature", async ({ page }) => {
  await page.locator("#pause").click();
  await expect(page.locator("#pop-count")).toHaveText("23");
  await page.locator("#world").click({ position: { x: 60, y: 60 }, modifiers: ["Shift"] });
  await expect(page.locator("#pop-count")).toHaveText("24");
});

test("reset restores the initial state", async ({ page }) => {
  await page.locator("#pause").click();
  await page.locator("#world").click({ position: { x: 50, y: 50 } });
  await page.locator("#world").click({ position: { x: 90, y: 90 }, modifiers: ["Shift"] });
  await expect(page.locator("#pop-count")).toHaveText("24");
  await page.locator("#reset").click();
  await expect(page.locator("#pop-count")).toHaveText("23");
  await expect(page.locator("#food-count")).toHaveText("0");
  await expect(page.locator("#elapsed")).toHaveText("0.0");
});

test("selecting a creature shows its stats and highlights it; the panel says died on death", async ({ page }) => {
  await page.locator("#pause").click();
  const target = await page.evaluate(() => {
    const world = window.__world;
    world.creatures.splice(1);
    const c = world.creatures[0];
    c.x = 100;
    c.y = 100;
    return { x: c.x, y: c.y, generation: c.generation };
  });
  await page.locator("#world").click({ position: { x: target.x, y: target.y } });
  await expect(page.locator("#inspector-stats")).toBeVisible();
  await expect(page.locator("#insp-status")).toHaveText("alive");
  await expect(page.locator("#insp-gen")).toHaveText(String(target.generation));
  for (const id of ["insp-energy", "insp-age", "insp-speed", "insp-color"]) {
    await expect(page.locator(`#${id}`)).not.toBeEmpty();
  }

  await page.evaluate(() => {
    window.__world.creatures.shift();
  });
  await expect(page.locator("#insp-status")).toHaveText("died");
});

test("clicks respect the food and creature caps", async ({ page }) => {
  await page.locator("#pause").click();
  const limits = await page.evaluate(() => {
    const { config } = window.__world;
    return { maxFood: config.maxFood, maxCreatures: config.maxCreatures };
  });
  const canvas = page.locator("#world");
  for (let i = 0; i < Math.ceil(limits.maxFood / 8) + 2; i++) {
    await canvas.click({ position: { x: 50 + i, y: 50 } });
  }
  for (let i = 0; i < limits.maxCreatures; i++) {
    await canvas.click({ position: { x: 100 + (i % 400), y: 300 }, modifiers: ["Shift"] });
  }
  const sizes = await page.evaluate(() => ({ food: window.__world.food.length, creatures: window.__world.creatures.length }));
  expect(sizes.food).toBeLessThanOrEqual(limits.maxFood);
  expect(sizes.creatures).toBe(limits.maxCreatures);
});
