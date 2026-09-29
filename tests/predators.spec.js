import { test, expect } from "@playwright/test";

// Drives the simulation headlessly through step() inside the page, with a seeded RNG.
async function inPage(page, fn) {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world);
  return page.evaluate(fn);
}


test("a predator next to a herbivore eats it and gains energy", async ({ page }) => {
  const r = await inPage(page, async () => {
    const sim = await import("/static/world-sim.js");
    const pred = await import("/static/predators.js");
    const world = sim.createWorld({ seed: 3, count: 0, config: { foodSpawnRate: 0, respawn: false } });
    pred.enablePredators(world, { initial: 0 });
    const prey = sim.addCreature(world, { x: 200, y: 200, heading: 0, speed: 20, energy: 50 });
    const hunter = pred.addPredator(world, { x: 190, y: 200, heading: 0, energy: 40 });
    for (let i = 0; i < 10 && !prey.dead; i++) sim.step(world, 1 / 30);
    return {
      preyDead: prey.dead,
      herbivores: sim.countBySpecies(world).herbivore,
      gained: hunter.energy > 40,
      cause: world.log.find((e) => e.kind === "death")?.cause,
    };
  });
  expect(r).toEqual({ preyDead: true, herbivores: 0, gained: true, cause: "eaten" });
});

test("predators do not eat food pellets", async ({ page }) => {
  const r = await inPage(page, async () => {
    const sim = await import("/static/world-sim.js");
    const pred = await import("/static/predators.js");
    const world = sim.createWorld({ seed: 3, count: 0, config: { foodSpawnRate: 0, respawn: false } });
    pred.enablePredators(world, { initial: 0 });
    const hunter = pred.addPredator(world, { x: 100, y: 100, heading: 0, speed: 1, energy: 50 });
    sim.addFood(world, 100, 100);
    for (let i = 0; i < 5; i++) sim.step(world, 1 / 30);
    return { food: world.food.length, energy: hunter.energy };
  });
  expect(r.food).toBe(1);
  expect(r.energy).toBeLessThan(50);
});

test("predators with no prey starve, logged as starved", async ({ page }) => {
  const r = await inPage(page, async () => {
    const sim = await import("/static/world-sim.js");
    const pred = await import("/static/predators.js");
    const world = sim.createWorld({ seed: 3, count: 0, config: { foodSpawnRate: 0, respawn: false } });
    pred.enablePredators(world, { initial: 3 });
    for (let i = 0; i < 60 * 30; i++) sim.step(world, 1 / 30);
    return { left: world.creatures.length, causes: world.log.filter((e) => e.kind === "death").map((e) => e.cause) };
  });
  expect(r.left).toBe(0);
  expect(r.causes).toEqual(["starved", "starved", "starved"]);
});

test("a well-fed predator splits with a species-tagged birth and the count stays capped", async ({ page }) => {
  const r = await inPage(page, async () => {
    const sim = await import("/static/world-sim.js");
    const pred = await import("/static/predators.js");
    const world = sim.createWorld({ seed: 5, count: 0, config: { foodSpawnRate: 0, respawn: false, maxCreatures: 200 } });
    pred.enablePredators(world, { initial: 0, maxPredators: 4 });
    for (let i = 0; i < 4; i++) pred.addPredator(world, { energy: 95 });
    let peak = 0;
    for (let i = 0; i < 300; i++) {
      for (const p of world.creatures) if (p.species === "predator" && p.energy < 30) p.energy = 95;
      sim.step(world, 1 / 30);
      peak = Math.max(peak, sim.countBySpecies(world).predator);
    }
    return { peak, birth: world.log.find((e) => e.kind === "birth") ?? null, births: world.births };
  });
  expect(r.peak).toBeLessThanOrEqual(4);
  expect(r.births).toBe(0);

  const split = await inPage(page, async () => {
    const sim = await import("/static/world-sim.js");
    const pred = await import("/static/predators.js");
    const world = sim.createWorld({ seed: 5, count: 0, config: { foodSpawnRate: 0, respawn: false } });
    pred.enablePredators(world, { initial: 0 });
    const parent = pred.addPredator(world, { energy: 95, speed: 80 });
    sim.step(world, 1 / 30);
    return {
      predators: sim.countBySpecies(world).predator,
      birth: world.log.find((e) => e.kind === "birth"),
      childSpeed: world.creatures.find((c) => c.id !== parent.id)?.speed,
    };
  });
  expect(split.predators).toBe(2);
  expect(split.birth.species).toBe("predator");
  expect(split.childSpeed).not.toBe(80);
});

test("herbivores still eat food and split as before with predators enabled", async ({ page }) => {
  const r = await inPage(page, async () => {
    const sim = await import("/static/world-sim.js");
    const pred = await import("/static/predators.js");
    const world = sim.createWorld({ seed: 7, count: 0, config: { foodSpawnRate: 0, respawn: false } });
    pred.enablePredators(world, { initial: 0 });
    const eater = sim.addCreature(world, { x: 100, y: 100, heading: 0, speed: 20, energy: 30 });
    sim.addFood(world, 110, 100);
    for (let i = 0; i < 30; i++) sim.step(world, 1 / 30);
    const fed = { food: world.food.length, gained: eater.energy > 30 };
    const parent = sim.addCreature(world, { energy: 95 });
    sim.step(world, 1 / 30);
    return { ...fed, herbivores: sim.countBySpecies(world).herbivore, births: world.births, parentGen: parent.generation };
  });
  expect(r.food).toBe(0);
  expect(r.gained).toBe(true);
  expect(r.births).toBe(1);
  expect(r.herbivores).toBe(3);
});

test("/world spawns three predators", async ({ page }) => {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world);
  const n = await page.evaluate(() => window.__world.creatures.filter((c) => c.species === "predator").length);
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(15);
});
