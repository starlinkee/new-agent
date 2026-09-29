import http from "node:http";
import { test, expect } from "@playwright/test";
import { Biome } from "../src/biome.js";
import { createBiomeFoodHandler } from "../src/biome-food.js";

const MOCK_STATE = {
  tick: 1,
  width: 900,
  height: 900,
  sky: { time: 0.5, phase: "day", weather: "clear" },
  creatures: [{ id: 9001, species: "herbivore", x: 300, y: 300, heading: 0.5, radius: 7, hue: 120, energy: 50, generation: 1, age: 3 }],
  food: [],
  effects: [],
  observers: [],
};

async function mockStream(page, extra = "") {
  await page.route("**/api/biome/stream", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
      body: `retry: 600000\n\nevent: state\ndata: ${JSON.stringify(MOCK_STATE)}\n\n${extra}`,
    }),
  );
}

async function observing(playwright, baseURL) {
  const api = await playwright.request.newContext({ baseURL });
  const res = await api.post("/api/biome/observe", { data: { name: "feeder" } });
  expect(res.status()).toBe(201);
  return api;
}

test("a drop becomes food in the shared world", async ({ playwright, baseURL }) => {
  const api = await observing(playwright, baseURL);
  const res = await api.post("/api/biome/food", { data: { x: 123.4, y: 567.8 } });
  expect(res.status()).toBe(201);
  expect(await res.json()).toEqual({ x: 123.4, y: 567.8 });
  const state = await (await api.get("/api/biome/state")).json();
  expect(state.food).toContainEqual([123, 568]);
  await api.dispose();
});

test("invalid points are 400 and dropping without observing is 404", async ({ playwright, baseURL }) => {
  const api = await observing(playwright, baseURL);
  for (const data of [{ x: -1, y: 5 }, { x: 5, y: 901 }, { x: 901, y: 5 }, { x: "5", y: 5 }, { x: 5 }, { x: null, y: 5 }]) {
    expect((await api.post("/api/biome/food", { data })).status()).toBe(400);
  }
  await api.dispose();

  const stranger = await playwright.request.newContext({ baseURL });
  const res = await stranger.post("/api/biome/food", { data: { x: 5, y: 5 } });
  expect(res.status()).toBe(404);
  expect(await res.json()).toEqual({ error: "not observing" });
  await stranger.dispose();
});

test("six drops in a row: five are accepted, the sixth is rate limited", async ({ playwright, baseURL }) => {
  const api = await observing(playwright, baseURL);
  const statuses = [];
  let last;
  for (let i = 0; i < 6; i++) {
    last = await api.post("/api/biome/food", { data: { x: 10 + i, y: 10 } });
    statuses.push(last.status());
  }
  expect(statuses.filter((s) => s === 201)).toHaveLength(5);
  expect(statuses[5]).toBe(429);
  expect(Number(last.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
  const body = await last.json();
  expect(typeof body.error).toBe("string");
  expect(body.retryAfterMs).toBeGreaterThan(0);
  await api.dispose();
});

test("a full world answers 409", async () => {
  const store = new Biome({ seed: 1 });
  const handler = createBiomeFoodHandler({ store, burst: 100 });
  const server = http.createServer(async (req, res) => {
    if (!(await handler(req, res))) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  try {
    const clientId = "a".repeat(32);
    store.observe({ name: "solo", clientId });
    const drop = () => fetch(`${base}/api/biome/food`, { method: "POST", headers: { "content-type": "application/json", cookie: `biome_client=${clientId}` }, body: JSON.stringify({ x: 50, y: 50 }) });
    while (store.world.food.length < store.world.config.maxFood) expect((await drop()).status).toBe(201);
    const res = await drop();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "food is full" });
  } finally {
    server.close();
  }
});

test("clicking empty terrain drops food, clicking a creature does not", async ({ page }) => {
  await mockStream(page);
  const posts = [];
  await page.route("**/api/biome/food", (route) => {
    posts.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { x: 0, y: 0 } });
  });
  await page.goto("/biome");
  await page.waitForFunction(() => window.__biome?.state?.tick === 1);
  await expect(page.locator("#biome-feed")).toContainText("Click the ground to drop food");

  const creature = await page.evaluate(() => window.__biome.toScreen(300, 300));
  await page.mouse.click(creature.x, creature.y);
  await page.waitForTimeout(300);
  expect(posts).toHaveLength(0);

  const target = { x: 650, y: 650 };
  const at = await page.evaluate(({ x, y }) => window.__biome.toScreen(x, y), target);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => posts.length).toBe(1);
  expect(Math.hypot(posts[0].x - target.x, posts[0].y - target.y)).toBeLessThan(15);
});

test("everyone sees a seed fall when someone drops food", async ({ browser }) => {
  test.setTimeout(90_000);
  const watcherContext = await browser.newContext();
  const watcher = await watcherContext.newPage();
  await watcher.goto("/biome");
  await watcher.waitForFunction(() => window.__biome?.me);
  // The seed only lives about a second, so record it as it appears instead of polling for it.
  await watcher.evaluate(() => {
    window.__seeds = [];
    window.__biome.ctx.onEvent((event) => {
      if (event.type !== "food") return;
      const group = window.__biome.scene.getObjectByName("biome-plugin-feeding");
      const seed = group.children[group.children.length - 1];
      window.__seeds.push({ event, color: seed.material.color.getHexString(), y: seed.position.y });
    });
  });

  const feederContext = await browser.newContext();
  const feeder = await feederContext.newPage();
  await feeder.goto("/biome");
  await feeder.waitForFunction(() => window.__biome?.me);
  const me = await feeder.evaluate(() => window.__biome.me);
  const dropped = await feeder.evaluate(() => window.__biome.ctx.api("/api/biome/food", { x: 450, y: 450 }));
  expect(dropped.status).toBe(201);

  await watcher.waitForFunction(() => window.__seeds.length > 0, null, { timeout: 10000, polling: 100 });
  const [seen] = await watcher.evaluate(() => window.__seeds);
  expect(seen.event).toMatchObject({ x: 450, y: 450, observerId: me.id, color: me.color });
  expect(seen.color).toBe(me.color.slice(1));
  expect(seen.y).toBeGreaterThan(250);
  await watcherContext.close();
  await feederContext.close();
});

test("a rate limit response shows its message in #biome-feed", async ({ page }) => {
  await mockStream(page);
  await page.route("**/api/biome/food", (route) => route.fulfill({ status: 429, headers: { "retry-after": "1" }, json: { error: "slow down: too many drops", retryAfterMs: 800 } }));
  await page.goto("/biome");
  await page.waitForFunction(() => window.__biome?.state?.tick === 1);
  const at = await page.evaluate(() => window.__biome.toScreen(650, 650));
  await page.mouse.click(at.x, at.y);
  await expect(page.locator("#biome-feed")).toContainText("slow down: too many drops");
  await expect(page.locator("#biome-feed")).toContainText("Click the ground to drop food", { timeout: 4000 });
});
