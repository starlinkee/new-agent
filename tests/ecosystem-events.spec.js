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
    const { ECOSYSTEM_EVENTS } = await import("/static/events-ecosystem.js");
    const world = sim.createWorld({ seed: 1, count: 0, config: { respawn: false } });
    for (let i = 0; i < 50; i++) sim.addFood(world);
    const fired = createEvents({ seed: 1, extensions: ECOSYSTEM_EVENTS }).trigger(world, "famine");
    return { left: world.food.length, affected: fired.affected };
  });
  expect(r).toEqual({ left: 20, affected: 30 });
});

test("frenzy boosts predators and restores them after the duration", async ({ page }) => {
  await openWorld(page);
  const r = await page.evaluate(async () => {
    const sim = await import("/static/world-sim.js");
    const { createEvents } = await import("/static/events.js");
    const { ECOSYSTEM_EVENTS } = await import("/static/events-ecosystem.js");
    const { enablePredators, effectiveSpeed, effectiveVision } = await import("/static/predators.js");
    const world = sim.createWorld({ seed: 2, count: 0, config: { respawn: false } });
    enablePredators(world);
    world.creatures.length = 0;
    const p = sim.addCreature(world, { species: "predator", speed: 40 });
    const baseVision = effectiveVision(world, p);
    const events = createEvents({ seed: 2, extensions: ECOSYSTEM_EVENTS, config: { frenzyDuration: 5 } });
    events.trigger(world, "frenzy");
    const boosted = { speed: effectiveSpeed(p), vision: effectiveVision(world, p), base: p.speed };
    events.update(world, 3);
    const during = effectiveSpeed(p);
    events.update(world, 3);
    return {
      baseVision,
      boosted,
      during,
      after: effectiveSpeed(p),
      speed: p.speed,
      vision: effectiveVision(world, p),
      boost: p.boost,
      effects: events.effects.length,
    };
  });
  expect(r.boosted.speed).toBeCloseTo(60);
  expect(r.boosted.vision).toBeCloseTo(r.baseVision * 1.5);
  expect(r.boosted.base).toBe(40);
  expect(r.during).toBeCloseTo(60);
  expect(r.after).toBe(40);
  expect(r.speed).toBe(40);
  expect(r.vision).toBe(r.baseVision);
  expect(r.boost).toBeUndefined();
  expect(r.effects).toBe(0);
});

test("overlapping frenzies do not compound and fully restore predators", async ({ page }) => {
  await openWorld(page);
  const r = await page.evaluate(async () => {
    const sim = await import("/static/world-sim.js");
    const { createEvents } = await import("/static/events.js");
    const { ECOSYSTEM_EVENTS } = await import("/static/events-ecosystem.js");
    const { enablePredators, effectiveSpeed, effectiveVision } = await import("/static/predators.js");
    const world = sim.createWorld({ seed: 3, count: 0, config: { respawn: false } });
    enablePredators(world);
    world.creatures.length = 0;
    const p = sim.addCreature(world, { species: "predator", speed: 40 });
    const baseVision = effectiveVision(world, p);
    const events = createEvents({ seed: 3, extensions: ECOSYSTEM_EVENTS, config: { frenzyDuration: 5 } });
    events.trigger(world, "frenzy"); // A: expires at t=5
    events.update(world, 2);
    events.trigger(world, "frenzy"); // B: expires at t=7
    const both = effectiveSpeed(p);
    events.update(world, 3.5); // t=5.5, A expired, B still running
    const onlyB = effectiveSpeed(p);
    events.update(world, 2); // t=7.5, both expired
    return { baseVision, both, onlyB, after: effectiveSpeed(p), speed: p.speed, vision: effectiveVision(world, p), frenzy: p.frenzy };
  });
  expect(r.both).toBeCloseTo(60);
  expect(r.onlyB).toBeCloseTo(60);
  expect(r.after).toBe(40);
  expect(r.speed).toBe(40);
  expect(r.vision).toBe(r.baseVision);
  expect(r.frenzy).toBeUndefined();
});

test("predators born during a frenzy inherit the unboosted speed", async ({ page }) => {
  await openWorld(page);
  const r = await page.evaluate(async () => {
    const sim = await import("/static/world-sim.js");
    const { createEvents } = await import("/static/events.js");
    const { ECOSYSTEM_EVENTS } = await import("/static/events-ecosystem.js");
    const { enablePredators } = await import("/static/predators.js");
    const world = sim.createWorld({ seed: 4, count: 0, config: { respawn: false, foodSpawnRate: 0 } });
    enablePredators(world);
    world.creatures.length = 0;
    const t = world.config.species.predator;
    const p = sim.addCreature(world, { species: "predator", speed: 60, energy: t.splitThreshold + 50 });
    createEvents({ seed: 4, extensions: ECOSYSTEM_EVENTS, config: { frenzyDuration: 100 } }).trigger(world, "frenzy");
    sim.step(world, 0.01);
    const child = world.creatures.find((c) => c !== p && c.species === "predator");
    return { child: child && { speed: child.speed, boost: child.boost }, max: 60 * (1 + t.speedMutation) };
  });
  expect(r.child).toBeTruthy();
  expect(r.child.boost).toBeUndefined();
  expect(r.child.speed).toBeLessThanOrEqual(r.max + 1e-9);
});

test("ecosystem events are opt-in per instance and leave built-in seeded sequences unchanged", async ({ page }) => {
  await openWorld(page);
  const r = await page.evaluate(async () => {
    const sim = await import("/static/world-sim.js");
    const { createEvents, EVENT_TYPES } = await import("/static/events.js");
    const run = () => {
      const world = sim.createWorld({ seed: 5, count: 10 });
      const events = createEvents({ seed: 9 });
      const fired = [];
      for (let i = 0; i < 20; i++) fired.push(events.trigger(world).type);
      return { fired, types: [...events.types] };
    };
    const before = run();
    const { ECOSYSTEM_EVENTS } = await import("/static/events-ecosystem.js");
    const withExt = createEvents({ seed: 9, extensions: ECOSYSTEM_EVENTS });
    let plainError = null;
    try { createEvents({ seed: 9 }).trigger(sim.createWorld({ seed: 1 }), "famine"); } catch (e) { plainError = e.name; }
    return { before, after: run(), builtins: [...EVENT_TYPES], extTypes: [...withExt.types], plainError };
  });
  expect(r.after).toEqual(r.before);
  expect(r.before.types).toEqual(r.builtins);
  expect(r.builtins).toEqual(["meteor", "bloom", "plague", "babyboom"]);
  expect(r.extTypes).toEqual([...r.builtins, "famine", "frenzy", "migration"]);
  expect(r.plainError).toBe("RangeError");
});

test("extensions cannot silently replace an existing event type", async ({ page }) => {
  await openWorld(page);
  const r = await page.evaluate(async () => {
    const { createEvents } = await import("/static/events.js");
    const handler = () => ({ text: "x", affected: 0 });
    const errors = [];
    for (const extensions of [[{ type: "plague", handler }], [{ type: "a", handler }, { type: "a", handler }]]) {
      try { createEvents({ extensions }); errors.push(null); } catch (e) { errors.push(e.message); }
    }
    const replaced = createEvents({ extensions: [{ type: "plague", handler, override: true }] });
    return { errors, types: [...replaced.types] };
  });
  expect(r.errors[0]).toMatch(/already defined/);
  expect(r.errors[1]).toMatch(/already defined/);
  expect(r.types).toEqual(["meteor", "bloom", "plague", "babyboom"]);
});

test("every ecosystem event type has a renderer", async ({ page }) => {
  await openWorld(page);
  const r = await page.evaluate(async () => {
    const { ECOSYSTEM_EVENTS } = await import("/static/events-ecosystem.js");
    const { ECOSYSTEM_RENDERERS } = await import("/static/render-ecosystem.js");
    return ECOSYSTEM_EVENTS.map((e) => [e.type, typeof ECOSYSTEM_RENDERERS[e.type]]);
  });
  expect(r).toEqual([["famine", "function"], ["frenzy", "function"], ["migration", "function"]]);
});

test("migration adds herbivores and shows in the ticker", async ({ page }) => {
  await openWorld(page);
  const before = await page.evaluate(() => window.__world.creatures.length);
  await page.evaluate(() => window.__events.trigger(window.__world, "migration"));
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
