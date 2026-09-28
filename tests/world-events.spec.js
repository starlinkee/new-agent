import { test, expect } from "@playwright/test";

async function openWorld(page) {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world && window.__events);
}

test("trigger button adds an event entry to the ticker", async ({ page }) => {
  await openWorld(page);
  await expect(page.locator("#ticker li[data-kind='event']")).toHaveCount(0);
  await page.locator("#trigger-event").click();
  await expect(page.locator("#ticker li[data-kind='event']")).toHaveCount(1);
  await expect(page.locator("#ticker li[data-kind='event'] time")).toHaveText(/^\d+:\d\d$/);
});

test("ticker never shows more than 8 entries", async ({ page }) => {
  await openWorld(page);
  for (let i = 0; i < 12; i++) await page.locator("#trigger-event").click();
  await expect(page.locator("#ticker li")).toHaveCount(8);
});

test("births and deaths appear in the log", async ({ page }) => {
  await openWorld(page);
  await page.evaluate(() => {
    const [parent, victim] = window.__world.creatures;
    parent.energy = 95;
    victim.energy = 0.01;
  });
  await expect(page.locator("#ticker li[data-kind='birth']").first()).toContainText(/Creature #\d+ \(gen 1\) was born/);
  await expect(page.locator("#ticker li[data-kind='death']").first()).toContainText(/Creature #\d+ starved/);
});

test("a meteor kills creatures inside its radius and spares the rest", async ({ page }) => {
  await openWorld(page);
  const result = await page.evaluate(async () => {
    const sim = await import("/static/world-sim.js");
    const { createEvents } = await import("/static/events.js");
    const world = sim.createWorld({ seed: 3, count: 0, config: { respawn: false } });
    for (let i = 0; i < 6; i++) sim.addCreature(world, { x: 300 + i * 5, y: 300 });
    const far = sim.addCreature(world, { x: 700, y: 500 });
    const events = createEvents({ seed: 3 });
    const before = world.creatures.length;
    const fired = events.trigger(world, "meteor", { x: 300, y: 300, radius: 60 });
    return { before, after: world.creatures.length, farAlive: world.creatures.includes(far), text: fired.text, kind: world.log.at(-1).kind };
  });
  expect(result).toEqual({ before: 7, after: 1, farAlive: true, text: "Meteor hit! 6 creatures lost", kind: "event" });
});

test("scheduler fires events every 15-40 seconds deterministically for a seed", async ({ page }) => {
  await openWorld(page);
  const runs = await page.evaluate(async () => {
    const sim = await import("/static/world-sim.js");
    const { createEvents } = await import("/static/events.js");
    const run = () => {
      const world = sim.createWorld({ seed: 5, count: 10 });
      const events = createEvents({ seed: 9 });
      const times = [];
      for (let t = 0; t < 200 * 10; t++) {
        const fired = events.update(world, 0.1);
        if (fired) times.push([Math.round(world.time * 10) / 10, fired.type]);
        world.time += 0.1;
      }
      return times;
    };
    return [run(), run()];
  });
  expect(runs[0]).toEqual(runs[1]);
  const times = runs[0].map(([t]) => t);
  expect(times.length).toBeGreaterThanOrEqual(5);
  times.forEach((t, i) => {
    const gap = t - (times[i - 1] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(14.9);
    expect(gap).toBeLessThanOrEqual(40.1);
  });
});

test("bloom adds food, plague drains energy, baby boom adds creatures", async ({ page }) => {
  await openWorld(page);
  const r = await page.evaluate(async () => {
    const sim = await import("/static/world-sim.js");
    const { createEvents } = await import("/static/events.js");
    const world = sim.createWorld({ seed: 4, count: 0, config: { respawn: false, foodSpawnRate: 0 } });
    for (let i = 0; i < 10; i++) sim.addCreature(world, { energy: 70 });
    const events = createEvents({ seed: 4 });
    events.trigger(world, "bloom");
    const food = world.food.length;
    const boom = events.trigger(world, "babyboom");
    const count = world.creatures.length;
    events.trigger(world, "plague");
    const infected = world.creatures.filter((c) => c.plague);
    const before = infected.map((c) => c.energy);
    events.update(world, 1);
    const drained = infected.every((c, i) => c.energy < before[i]);
    return { food, boomBorn: boom.affected, count, drained, infected: infected.length };
  });
  expect(r.food).toBe(30);
  expect(r.boomBorn).toBe(10);
  expect(r.count).toBe(20);
  expect(r.infected).toBeGreaterThan(0);
  expect(r.drained).toBe(true);
});

test("meteor kills are counted as deaths and flagged dead", async ({ page }) => {
  await openWorld(page);
  const r = await page.evaluate(async () => {
    const sim = await import("/static/world-sim.js");
    const { createEvents } = await import("/static/events.js");
    const world = sim.createWorld({ seed: 3, count: 0, config: { respawn: false } });
    const doomed = [0, 1, 2].map((i) => sim.addCreature(world, { x: 100 + i, y: 100 }));
    sim.addCreature(world, { x: 700, y: 500 });
    createEvents({ seed: 3 }).trigger(world, "meteor", { x: 100, y: 100, radius: 30 });
    return { deaths: world.deaths, flagged: doomed.every((c) => c.dead), remaining: world.creatures.length };
  });
  expect(r).toEqual({ deaths: 3, flagged: true, remaining: 1 });
});

test("a plague victim that dies mid-effect is dropped from the effect", async ({ page }) => {
  await openWorld(page);
  const r = await page.evaluate(async () => {
    const sim = await import("/static/world-sim.js");
    const { createEvents } = await import("/static/events.js");
    const world = sim.createWorld({ seed: 6, count: 0, config: { respawn: false, foodSpawnRate: 0 } });
    for (let i = 0; i < 10; i++) sim.addCreature(world, { energy: 90 });
    const events = createEvents({ seed: 6, config: { plagueMinFraction: 1, plagueMaxFraction: 1 } });
    events.trigger(world, "plague");
    const infected = events.effects[0].victims.length;
    const [victim] = world.creatures;
    sim.removeCreatures(world, (c) => c === victim, "meteor", { silent: true });
    events.update(world, 0.1);
    return { infected, tracked: events.effects[0].victims.length, tracksDead: events.effects[0].victims.includes(victim) };
  });
  expect(r).toEqual({ infected: 10, tracked: 9, tracksDead: false });
});

test("overlapping plagues keep victims infected until both expire", async ({ page }) => {
  await openWorld(page);
  const r = await page.evaluate(async () => {
    const sim = await import("/static/world-sim.js");
    const { createEvents } = await import("/static/events.js");
    const world = sim.createWorld({ seed: 7, count: 0, config: { respawn: false, foodSpawnRate: 0 } });
    const c = sim.addCreature(world, { energy: 100 });
    const events = createEvents({ seed: 7, config: { plagueMinFraction: 1, plagueMaxFraction: 1, plagueDuration: 2, plagueDrain: 1 } });
    events.trigger(world, "plague");
    events.update(world, 1.5);
    events.trigger(world, "plague");
    const both = c.plague;
    events.update(world, 1); // first plague expires, second still active
    const afterFirst = c.plague;
    events.update(world, 1.5);
    return { both, afterFirst, afterAll: c.plague };
  });
  expect(r).toEqual({ both: 2, afterFirst: 1, afterAll: 0 });
});

test("unknown event types are rejected", async ({ page }) => {
  await openWorld(page);
  const message = await page.evaluate(async () => {
    const sim = await import("/static/world-sim.js");
    const { createEvents } = await import("/static/events.js");
    try {
      createEvents({ seed: 1 }).trigger(sim.createWorld({ seed: 1 }), "typo");
    } catch (e) {
      return e.message;
    }
    return null;
  });
  expect(message).toBe('Unknown event type "typo"');
});
