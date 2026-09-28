import { test, expect } from "@playwright/test";

async function inPage(page, fn, arg) {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world);
  return page.evaluate(fn, arg);
}

test("a seeded world with no systems evolves exactly as before", async ({ page }) => {
  const result = await inPage(page, async () => {
    const sim = await import("/static/world-sim.js");
    const world = sim.createWorld({ seed: 42, width: 800, height: 600 });
    for (let i = 0; i < 600; i++) sim.step(world, 1 / 30);
    return {
      n: world.creatures.length,
      births: world.births,
      deaths: world.deaths,
      first: world.creatures.slice(0, 3).map((c) => [+c.x.toFixed(4), +c.y.toFixed(4)]),
      counts: sim.countBySpecies(world),
    };
  });
  expect(result.n).toBe(39);
  expect(result.births).toBe(19);
  expect(result.deaths).toBe(0);
  expect(result.first).toEqual([
    [482.5946, 54.9512],
    [389.8944, 151.0167],
    [743.8663, 313.3614],
  ]);
  expect(result.counts).toEqual({ herbivore: 39 });
});

test("registered systems run once per step with (world, dt), in order", async ({ page }) => {
  const result = await inPage(page, async () => {
    const sim = await import("/static/world-sim.js");
    const calls = [];
    const world = sim.createWorld({ seed: 1, count: 0, systems: [(w, dt) => calls.push(["a", w, dt])] });
    sim.registerSystem(world, (w, dt) => calls.push(["b", w, dt]));
    sim.step(world, 0.05);
    sim.step(world, 0.05);
    return {
      order: calls.map((c) => c[0]),
      sameWorld: calls.every((c) => c[1] === world),
      dts: calls.map((c) => c[2]),
    };
  });
  expect(result.order).toEqual(["a", "b", "a", "b"]);
  expect(result.sameWorld).toBe(true);
  expect(result.dts).toEqual([0.05, 0.05, 0.05, 0.05]);
});

test("split() children keep the parent's species", async ({ page }) => {
  const result = await inPage(page, async () => {
    const sim = await import("/static/world-sim.js");
    const world = sim.createWorld({ seed: 3, count: 0 });
    const plain = sim.addCreature(world, { energy: 90 });
    const other = sim.addCreature(world, { energy: 90, species: "predator" });
    return {
      defaultSpecies: plain.species,
      plainChild: sim.split(world, plain).species,
      otherChild: sim.split(world, other).species,
      hasConfig: "herbivore" in world.config.species,
    };
  });
  expect(result).toEqual({ defaultSpecies: "herbivore", plainChild: "herbivore", otherChild: "predator", hasConfig: true });
});
