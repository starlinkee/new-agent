import { test, expect } from "@playwright/test";

// Runs fn in the page with a `seeded(opts)` helper: a seeded headless world plus a fresh stats collector.
async function inPage(page, fn) {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world);
  return page.evaluate(`(${fn})((${async function seeded(opts) {
    const sim = await import("/static/world-sim.js");
    const { createStats } = await import("/static/stats.js");
    const world = sim.createWorld({ seed: 11, count: 20 });
    return { sim, world, stats: createStats(opts) };
  }}))`);
}

test("samples once per interval of simulated time", async ({ page }) => {
  const result = await inPage(page, async (seeded) => {
    const { sim, world, stats } = await seeded({ interval: 1 });
    for (let i = 0; i < 10 * 30; i++) {
      sim.step(world, 1 / 30);
      stats.maybeSample(world);
    }
    return { samples: stats.series.length };
  });
  // one at t=0 plus one per simulated second
  expect(result.samples).toBeGreaterThanOrEqual(10);
  expect(result.samples).toBeLessThanOrEqual(11);
});

test("ring buffer keeps at most capacity samples, newest last", async ({ page }) => {
  const result = await inPage(page, async (seeded) => {
    const { sim, world, stats } = await seeded({ interval: 1, capacity: 5 });
    for (let i = 0; i < 20 * 30; i++) {
      sim.step(world, 1 / 30);
      stats.maybeSample(world);
    }
    const times = stats.series.map((s) => s.time);
    return { length: stats.series.length, sorted: times.every((t, i) => i === 0 || t > times[i - 1]), first: times[0] };
  });
  expect(result.length).toBe(5);
  expect(result.sorted).toBe(true);
  expect(result.first).toBeGreaterThan(10);
});

test("species counts sum to the creature count and latest() matches the world", async ({ page }) => {
  const result = await inPage(page, async (seeded) => {
    const { sim, world, stats } = await seeded({ interval: 1 });
    for (let i = 0; i < 5 * 30; i++) sim.step(world, 1 / 30);
    stats.sample(world);
    const s = stats.latest();
    const sum = Object.values(s.counts).reduce((a, b) => a + b, 0);
    const avg = world.creatures.reduce((a, c) => a + c.energy, 0) / world.creatures.length;
    return { sum, n: world.creatures.length, s, food: world.food.length, births: world.births, deaths: world.deaths, time: world.time, avg };
  });
  expect(result.sum).toBe(result.n);
  expect(result.s.food).toBe(result.food);
  expect(result.s.births).toBe(result.births);
  expect(result.s.deaths).toBe(result.deaths);
  expect(result.s.time).toBe(result.time);
  expect(result.s.avgEnergy).toBeCloseTo(result.avg, 6);
});

test("the app world exposes live stats", async ({ page }) => {
  await page.goto("/world");
  await page.waitForFunction(() => window.__stats && window.__stats.series.length >= 2, null, { timeout: 15000 });
  const ok = await page.evaluate(() => {
    const l = window.__stats.latest();
    return l.time <= window.__world.time && typeof l.counts === "object";
  });
  expect(ok).toBe(true);
});
