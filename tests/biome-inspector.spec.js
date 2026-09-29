import { test, expect } from "@playwright/test";

const base = {
  tick: 1,
  width: 900,
  height: 900,
  sky: { time: 0.5, phase: "day", weather: "clear" },
  creatures: [
    { id: 9101, species: "herbivore", x: 300, y: 300, heading: 0.5, radius: 7, hue: 120, energy: 50, generation: 3, age: 12 },
    { id: 9102, species: "predator", x: 600, y: 600, heading: 2, radius: 9, hue: 0, energy: 80, generation: 2, age: 5 },
  ],
  food: [],
  effects: [],
  observers: [],
};

// Replaces EventSource with a handle the spec drives, so snapshots arrive when the test says so.
async function openMocked(page) {
  await page.addInitScript(() => {
    window.__sources = [];
    window.EventSource = class {
      constructor() {
        this.handlers = {};
        window.__sources.push(this);
      }
      addEventListener(type, fn) {
        (this.handlers[type] ||= []).push(fn);
      }
      close() {}
    };
    window.__push = (state) => {
      for (const source of window.__sources) for (const fn of source.handlers.state || []) fn({ data: JSON.stringify(state) });
    };
  });
  await page.goto("/biome");
  await page.waitForFunction(() => window.__sources.length > 0);
  await page.evaluate((state) => window.__push(state), base);
  await page.waitForFunction(() => window.__biome?.state?.tick === 1);
}

async function clickCreature(page, c) {
  const at = await page.evaluate(({ x, y }) => window.__biome.toScreen(x, y), c);
  await page.mouse.click(at.x, at.y);
}

const push = (page, state) => page.evaluate((s) => window.__push(s), state);
const targetDistance = (page, id) =>
  page.evaluate((cid) => {
    const { controls, ctx } = window.__biome;
    return controls.target.distanceTo(ctx.creatureObject(cid).position);
  }, id);

test("clicking a creature opens a live card that follows snapshots and closes on Escape", async ({ page }) => {
  await openMocked(page);
  await clickCreature(page, base.creatures[0]);

  const card = page.locator("#biome-inspector");
  await expect(card).toContainText("herbivore");
  await expect(card).toContainText("9101");
  await expect(card).toContainText("3");
  await expect(card).toContainText("50");
  await expect(card).toContainText("12");
  await expect(page.locator("#biome-follow")).toHaveText("Follow");
  expect(await page.evaluate(() => window.__biome.scene.getObjectByName("biome-plugin-inspector").children.length)).toBe(1);

  await push(page, { ...base, tick: 2, creatures: [{ ...base.creatures[0], energy: 77, age: 13 }, base.creatures[1]] });
  await expect(card).toContainText("77");
  await expect(card).toContainText("13 s");

  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  expect(await page.evaluate(() => window.__biome.scene.getObjectByName("biome-plugin-inspector").children.length)).toBe(0);
});

test("Follow eases the camera target toward the creature and toggles the label", async ({ page }) => {
  await openMocked(page);
  await clickCreature(page, base.creatures[1]);
  await expect(page.locator("#biome-inspector")).toBeVisible();

  const before = await targetDistance(page, 9102);
  await page.locator("#biome-follow").click();
  await expect(page.locator("#biome-follow")).toHaveText("Stop following");
  await page.waitForTimeout(1000);
  const after = await targetDistance(page, 9102);
  expect(after).toBeLessThan(before * 0.5);

  await page.locator("#biome-follow").click();
  await expect(page.locator("#biome-follow")).toHaveText("Follow");
});

test("a creature missing from a snapshot shows Died and the card closes itself", async ({ page }) => {
  await openMocked(page);
  await clickCreature(page, base.creatures[0]);
  await page.locator("#biome-follow").click();

  await push(page, { ...base, tick: 2, creatures: [base.creatures[1]] });
  const card = page.locator("#biome-inspector");
  await expect(card).toContainText("Died");
  await expect(card).toContainText("3");
  await expect(page.locator("#biome-follow")).toHaveText("Follow");
  expect(await page.evaluate(() => window.__biome.scene.getObjectByName("biome-plugin-inspector").children.length)).toBe(0);
  await expect(card).toHaveCount(0, { timeout: 3500 });
});

test("clicking empty terrain does not open the card, selecting another creature switches", async ({ page }) => {
  await openMocked(page);
  await clickCreature(page, { x: 100, y: 800 });
  await page.waitForTimeout(200);
  await expect(page.locator("#biome-inspector")).toHaveCount(0);

  await clickCreature(page, base.creatures[0]);
  await expect(page.locator("#biome-inspector")).toContainText("herbivore");
  await clickCreature(page, base.creatures[1]);
  await expect(page.locator("#biome-inspector")).toContainText("predator");
  await page.locator("#biome-inspector-close").click();
  await expect(page.locator("#biome-inspector")).toHaveCount(0);
});
