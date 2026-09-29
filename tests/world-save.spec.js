import { test, expect } from "@playwright/test";

async function openWorld(page) {
  await page.goto("/world");
  await page.waitForFunction(() => window.__world);
  await page.locator("#pause").click();
}

async function counts(page) {
  return page.evaluate(() => ({ creatures: window.__world.creatures.length, food: window.__world.food.length }));
}

const created = [];
test.afterEach(async ({ request }) => {
  const list = await (await request.get("/api/world/snapshots")).json();
  for (const s of list) if (created.includes(s.name)) await request.delete(`/api/world/snapshots/${s.id}`);
  created.length = 0;
});

function uniqueName(label) {
  const name = `${label} ${test.info().testId}`;
  created.push(name);
  return name;
}

async function saveAs(page, name) {
  await page.locator("#save-name").fill(name);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator("#save-list li", { hasText: name })).toBeVisible();
}

test("serializeWorld and restoreWorld round trip counts and species", async ({ page }) => {
  await openWorld(page);
  const result = await page.evaluate(async () => {
    const sim = await import("/static/world-sim.js");
    const { serializeWorld, restoreWorld } = await import("/static/world-serialize.js");
    const speciesConfig = { herbivore: {}, red: {}, blue: {}, green: {} };
    const world = sim.createWorld({ seed: 5, count: 0, config: { respawn: false, species: { ...speciesConfig } } });
    const species = ["red", "blue", "red", "green", "red"];
    species.forEach((s, i) => sim.addCreature(world, { species: s, generation: i, age: 10 + i, plague: 2 }));
    for (let i = 0; i < 7; i++) sim.addFood(world);
    world.time = 42;
    world.births = 3;
    world.deaths = 1;
    const data = JSON.parse(JSON.stringify(serializeWorld(world)));
    const target = sim.createWorld({ seed: 9, count: 3, config: { species: { ...speciesConfig } } });
    const random = target.random;
    restoreWorld(target, data);
    const mix = (w) => w.creatures.map((c) => c.species).sort().join(",");
    return {
      keys: Object.keys(data).sort(),
      creatures: target.creatures.length,
      food: target.food.length,
      sameMix: mix(target) === mix(world),
      plague: target.creatures.map((c) => c.plague),
      ages: target.creatures.map((c) => c.age),
      time: target.time,
      nextId: target.nextId === world.nextId,
      births: target.births,
      deaths: target.deaths,
      randomKept: target.random === random,
    };
  });
  expect(result.keys).not.toContain("random");
  expect(result.keys).not.toContain("systems");
  expect(result.keys).not.toContain("log");
  expect(result).toMatchObject({ creatures: 5, food: 7, sameMix: true, time: 42, nextId: true, births: 3, deaths: 1, randomKept: true });
  expect(result.plague).toEqual([0, 0, 0, 0, 0]);
  expect(result.ages).toEqual([10, 11, 12, 13, 14]);
});

test("restoreWorld rejects bad data without mutating the world", async ({ page }) => {
  await openWorld(page);
  const result = await page.evaluate(async () => {
    const { serializeWorld, restoreWorld } = await import("/static/world-serialize.js");
    const world = window.__world;
    const before = JSON.stringify(serializeWorld(world));
    const good = serializeWorld(world);
    const c = { id: 1, x: 1, y: 1, heading: 0, turnRate: 0, speed: 1, hue: 0, energy: 5, generation: 0, age: 0, species: "herbivore" };
    const dup = { ...good, creatures: [c, { ...c }] };
    const withSpecies = (species) => ({ ...good, config: { ...good.config, species } });
    const bad = [
      null,
      { ...good, creatures: "nope" },
      { ...good, time: "x" },
      { ...good, creatures: [{ id: 1 }] },
      { ...good, config: { ...good.config, maxEnergy: 0 } },
      { ...good, config: { ...good.config, bogus: 1 } },
      dup,
      { ...good, nextId: 0 },
      withSpecies({ red: {} }),
      withSpecies({ herbivore: { color: "<img src=x onerror=alert(1)>" } }),
      withSpecies({ herbivore: "x" }),
      { ...good, creatures: [{ ...c, id: 2, species: "ghost" }], nextId: 10 },
      { ...good, config: { ...good.config, foodRadius: -1 } },
      { ...good, creatures: Array.from({ length: good.config.maxCreatures + 1 }, (_, i) => ({ ...c, id: i })), nextId: 1000 },
      { ...good, food: Array.from({ length: good.config.maxFood + 1 }, () => ({ x: 1, y: 1 })) },
      { ...good, creatures: [{ ...c, x: world.width + 1 }], nextId: 10 },
      { ...good, food: [{ x: 1, y: -5 }] },
      { ...good, config: { ...good.config, maxCreatures: 1e9, maxFood: 1e9 } },
      { ...good, config: { ...good.config, foodRadius: 1e300 } },
      { ...good, creatures: [{ ...c, radius: -4 }], nextId: 10 },
      { ...good, creatures: [{ ...c, energy: -1 }], nextId: 10 },
      { ...good, creatures: [{ ...c, speed: -1 }], nextId: 10 },
    ];
    const messages = [];
    for (const data of bad) {
      try {
        restoreWorld(world, data);
        messages.push("no error");
      } catch (err) {
        messages.push(err.message);
      }
    }
    return { messages, unchanged: JSON.stringify(serializeWorld(world)) === before };
  });
  for (const m of result.messages) expect(m).toMatch(/^Invalid world data/);
  expect(result.unchanged).toBe(true);
});

test("restoreWorld keeps world.config, creatures and food identities", async ({ page }) => {
  await openWorld(page);
  const same = await page.evaluate(async () => {
    const { serializeWorld, restoreWorld } = await import("/static/world-serialize.js");
    const world = window.__world;
    const { config, creatures, food, config: { species } } = world;
    restoreWorld(world, serializeWorld(world));
    return world.config === config && world.creatures === creatures && world.food === food && world.config.species === species;
  });
  expect(same).toBe(true);
});

test("save via the panel, mutate, load restores the original counts", async ({ page }) => {
  await openWorld(page);
  const original = await counts(page);
  const name = uniqueName("first save");
  await saveAs(page, name);
  await expect(page.locator("#save-status")).toContainText(`Saved "${name}"`);
  await expect(page.locator("#save-list li", { hasText: name })).toContainText(`${original.creatures} creatures`);

  await page.evaluate(() => {
    window.__world.creatures.length = 2;
    window.__world.food.length = 0;
  });
  expect(await counts(page)).toEqual({ creatures: 2, food: 0 });

  const worldRef = await page.evaluateHandle(() => window.__world);
  await page.locator("#save-list li", { hasText: name }).getByRole("button", { name: "Load" }).click();
  await expect(page.locator("#save-status")).toContainText(`Loaded "${name}"`);
  expect(await counts(page)).toEqual(original);
  expect(await page.evaluate((w) => w === window.__world, worldRef)).toBe(true);
  await expect(page.locator("#ticker li[data-kind='event']", { hasText: `Loaded "${name}"` })).toHaveCount(1);
});

test("delete removes the row", async ({ page }) => {
  await openWorld(page);
  const name = uniqueName("doomed");
  await saveAs(page, name);
  const row = page.locator("#save-list li", { hasText: name });
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("#save-list li", { hasText: name })).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => window.__world);
  await expect(page.locator("#save-list li", { hasText: name })).toHaveCount(0);
});

test("corrupt snapshot data shows an error and leaves the world unchanged", async ({ page }) => {
  await openWorld(page);
  const name = uniqueName("corrupt me");
  await saveAs(page, name);
  await page.route("**/api/world/snapshots/*", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: { id: 1, name, data: { time: 1, creatures: "broken" } } });
  });
  await page.evaluate(() => (window.__world.food.length = 1));
  const before = await page.evaluate(() => JSON.stringify(window.__world.creatures));
  await page.locator("#save-list li", { hasText: name }).getByRole("button", { name: "Load" }).click();
  await expect(page.locator("#save-status")).toContainText(/Invalid world data/);
  await expect(page.locator("#save-status")).toHaveAttribute("data-state", "error");
  expect(await page.evaluate(() => JSON.stringify(window.__world.creatures))).toBe(before);
  expect((await counts(page)).food).toBe(1);
});
