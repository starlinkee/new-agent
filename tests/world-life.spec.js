import { test, expect } from "@playwright/test";

// Drives the simulation headlessly through step() inside the page, with a seeded RNG.
async function inPage(page, fn, arg) {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world);
  return page.evaluate(fn, arg);
}

test("a creature that eats gains energy", async ({ page }) => {
  const result = await inPage(page, async () => {
    const sim = await import("/static/world-sim.js");
    const world = sim.createWorld({ seed: 7, count: 0, config: { foodSpawnRate: 0, respawn: false } });
    const c = sim.addCreature(world, { x: 100, y: 100, heading: 0, speed: 20, energy: 30 });
    sim.addFood(world, 110, 100);
    const before = c.energy;
    for (let i = 0; i < 30; i++) sim.step(world, 1 / 30);
    return { before, after: c.energy, food: world.food.length };
  });
  expect(result.food).toBe(0);
  expect(result.after).toBeGreaterThan(result.before);
});

test("a starving creature dies", async ({ page }) => {
  const result = await inPage(page, async () => {
    const sim = await import("/static/world-sim.js");
    const world = sim.createWorld({ seed: 7, count: 0, config: { foodSpawnRate: 0, respawn: false } });
    sim.addCreature(world, { energy: 5 });
    for (let i = 0; i < 20 * 30; i++) sim.step(world, 1 / 30);
    return { alive: world.creatures.length, deaths: world.deaths };
  });
  expect(result).toEqual({ alive: 0, deaths: 1 });
});

test("a well-fed creature splits and the child is the next generation", async ({ page }) => {
  const result = await inPage(page, async () => {
    const sim = await import("/static/world-sim.js");
    const world = sim.createWorld({ seed: 7, count: 0, config: { foodSpawnRate: 0, respawn: false } });
    const parent = sim.addCreature(world, { hue: 200, speed: 40, energy: 95, generation: 2 });
    sim.step(world, 1 / 30);
    const [first, child] = world.creatures;
    return {
      count: world.creatures.length,
      sameParent: first === parent,
      parentGen: parent.generation,
      childGen: child.generation,
      childAge: child.age,
      parentEnergy: parent.energy,
      childEnergy: child.energy,
      hueDrift: Math.abs(child.hue - parent.hue),
      speedDrift: Math.abs(child.speed - parent.speed) / parent.speed,
    };
  });
  expect(result.count).toBe(2);
  expect(result.sameParent).toBe(true);
  expect(result.childGen).toBe(result.parentGen + 1);
  expect(result.childAge).toBe(0);
  expect(result.parentEnergy).toBeLessThan(50);
  expect(result.childEnergy).toBeCloseTo(result.parentEnergy, 5);
  expect(result.hueDrift).toBeLessThanOrEqual(14 + 1e-9);
  expect(result.speedDrift).toBeLessThanOrEqual(0.12 + 1e-9);
});

test("the default seeded world is deterministic and stays populated for 60s", async ({ page }) => {
  const run = () =>
    inPage(page, async () => {
      const sim = await import("/static/world-sim.js");
      const world = sim.createWorld({ seed: 42, width: 1200, height: 600 });
      let min = Infinity;
      let max = 0;
      for (let i = 0; i < 60 * 60; i++) {
        sim.step(world, 1 / 60);
        min = Math.min(min, world.creatures.length);
        max = Math.max(max, world.creatures.length);
      }
      return { min, max, xs: world.creatures.map((c) => c.x), maxGeneration: Math.max(...world.creatures.map((c) => c.generation)) };
    });
  const a = await run();
  const b = await run();
  expect(a).toEqual(b);
  expect(a.min).toBeGreaterThanOrEqual(5);
  expect(a.max).toBeLessThanOrEqual(80);
  expect(a.maxGeneration).toBeGreaterThan(0);
});

test("a dead world respawns founders", async ({ page }) => {
  const count = await inPage(page, async () => {
    const sim = await import("/static/world-sim.js");
    const world = sim.createWorld({ seed: 3, count: 1, config: { foodSpawnRate: 0 } });
    world.creatures[0].energy = 0.01;
    sim.step(world, 1);
    return world.creatures.length;
  });
  expect(count).toBe(5);
});

test("the live page renders food and creatures with life stats", async ({ page }) => {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world && window.__world.food.length > 0);
  const stats = await page.evaluate(() => window.__world.creatures.every((c) => c.energy > 0 && c.generation >= 0 && c.age >= 0));
  expect(stats).toBe(true);
});
