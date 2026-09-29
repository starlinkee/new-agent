import { test, expect } from "@playwright/test";

async function openWorld(page) {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world && window.__events);
}

test("famine removes about 60% of the food", async ({ page }) => {
  await openWorld(page);
  const r = await page.evaluate(async () => {
    const sim = await import("/static/world-sim.js");
    const { createEvents } = await import("/static/events.js");
    await import("/static/events-ecosystem.js");
    const world = sim.createWorld({ seed: 1, count: 0, config: { respawn: false } });
    for (let i = 0; i < 50; i++) sim.addFood(world);
    const fired = createEvents({ seed: 1 }).trigger(world, "famine");
    return { left: world.food.length, affected: fired.affected };
  });
  expect(r).toEqual({ left: 20, affected: 30 });
});

test("frenzy boosts predators and restores them after the duration", async ({ page }) => {
  await openWorld(page);
  const r = await page.evaluate(async () => {
    const sim = await import("/static/world-sim.js");
    const { createEvents } = await import("/static/events.js");
    await import("/static/events-ecosystem.js");
    const world = sim.createWorld({ seed: 2, count: 0, config: { respawn: false } });
    const p = sim.addCreature(world, { species: "predator", speed: 40 });
    const events = createEvents({ seed: 2, config: { frenzyDuration: 5 } });
    events.trigger(world, "frenzy");
    const boosted = { speed: p.speed, vision: p.vision };
    events.update(world, 3);
    const during = p.speed;
    events.update(world, 3);
    return { boosted, during, after: p.speed, vision: p.vision, effects: events.effects.length };
  });
  expect(r.boosted.speed).toBeCloseTo(60);
  expect(r.boosted.vision).toBeCloseTo(135);
  expect(r.during).toBeCloseTo(60);
  expect(r.after).toBe(40);
  expect(r.vision).toBeUndefined();
  expect(r.effects).toBe(0);
});

test("migration adds herbivores and shows in the ticker", async ({ page }) => {
  await openWorld(page);
  const before = await page.evaluate(() => window.__world.creatures.length);
  await page.evaluate(async () => {
    await import("/static/events-ecosystem.js");
    window.__events.trigger(window.__world, "migration");
  });
  expect(await page.evaluate(() => window.__world.creatures.length)).toBeGreaterThan(before);
  await expect(page.locator("#ticker li[data-kind='event']").first()).toContainText(/Migration! \d+ herbivores? arrived/);
});

test("unknown event types still throw RangeError", async ({ page }) => {
  await openWorld(page);
  const name = await page.evaluate(() => {
    try { window.__events.trigger(window.__world, "nope"); } catch (e) { return e.name; }
  });
  expect(name).toBe("RangeError");
});
