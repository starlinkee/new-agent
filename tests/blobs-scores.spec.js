import { test, expect } from "@playwright/test";
import { Arena } from "../src/blobs.js";
import { createBlobScores } from "../src/blobs-scores.js";

const uniqueName = () => `s${Math.random().toString(36).slice(2, 8)}`;

function setup(options) {
  const arena = new Arena({ foodCount: 0 });
  return { arena, scores: createBlobScores(arena, options) };
}

test("a human that leaves is recorded with its mass", () => {
  const { arena, scores } = setup();
  const p = arena.join({ name: "Ann", mass: 50 });
  arena.leave(p.id);
  expect(scores.top(10)).toEqual([{ name: "Ann", mass: 50, at: expect.any(Number) }]);
  expect(scores.recent(10)).toHaveLength(1);
  scores.stop();
});

test("a rejoin counts like a leave", () => {
  const { arena, scores } = setup();
  const p = arena.join({ name: "Rex", mass: 40 });
  arena.leave(p.id, "rejoin");
  expect(scores.top(10).map((e) => e.name)).toEqual(["Rex"]);
  scores.stop();
});

test("an eaten human is recorded with its peak mass", () => {
  const { arena, scores } = setup();
  const eater = arena.join({ name: "Big", mass: 100, x: 500, y: 500 });
  const victim = arena.join({ name: "Small", mass: 30, x: 500, y: 500 });
  arena.step(50);
  expect(arena.get(victim.id)).toBeUndefined();
  expect(scores.top(10)).toEqual([{ name: "Small", mass: 30, at: expect.any(Number) }]);
  arena.leave(eater.id);
  expect(scores.top(10).map((e) => e.name)).toEqual(["Big", "Small"]);
  scores.stop();
});

test("bots are never recorded, eaten or leaving", () => {
  const { arena, scores } = setup();
  const eater = arena.join({ name: "Hunter", mass: 100, x: 500, y: 500 });
  const bot = arena.join({ name: "Bot1", bot: true, mass: 30, x: 500, y: 500 });
  arena.step(50);
  expect(arena.get(bot.id)).toBeUndefined();
  const other = arena.join({ name: "Bot2", bot: true, mass: 60 });
  arena.leave(other.id);
  expect(scores.top(10)).toEqual([]);
  expect(scores.recent(10)).toEqual([]);
  arena.leave(eater.id);
  expect(scores.top(10).map((e) => e.name)).toEqual(["Hunter"]);
  scores.stop();
});

test("top is sorted by mass, ties older first, and capped", () => {
  let clock = 0;
  const { arena, scores } = setup({ now: () => ++clock });
  for (let i = 0; i < 12; i += 1) {
    const p = arena.join({ name: `p${i}`, mass: 20 + (i % 4) });
    arena.leave(p.id);
  }
  const top = scores.top(10);
  expect(top).toHaveLength(10);
  expect(top.map((e) => e.mass)).toEqual([...top.map((e) => e.mass)].sort((a, b) => b - a));
  expect(top.map((e) => e.name).slice(0, 3)).toEqual(["p3", "p7", "p11"]);
  const recent = scores.recent(10);
  expect(recent).toHaveLength(10);
  expect(recent[0].name).toBe("p11");
  scores.stop();
});

test("max keeps only the best entries and stop unsubscribes", () => {
  const { arena, scores } = setup({ max: 2 });
  for (const mass of [30, 60, 40]) arena.leave(arena.join({ name: `m${mass}`, mass }).id);
  expect(scores.top(10).map((e) => e.mass)).toEqual([60, 40]);
  scores.stop();
  arena.leave(arena.join({ name: "late", mass: 90 }).id);
  expect(scores.top(10).map((e) => e.mass)).toEqual([60, 40]);
});

test("live server lists a player that left, and rejects POST", async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext({ baseURL });
  const name = uniqueName();
  expect((await api.post("/api/blobs/join", { data: { name } })).status()).toBe(201);
  expect((await api.post("/api/blobs/leave")).status()).toBe(204);
  const res = await api.get("/api/blobs/scores");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.recent.some((e) => e.name === name)).toBe(true);
  expect(body.top.length).toBeLessThanOrEqual(10);
  const post = await api.post("/api/blobs/scores", { data: {} });
  expect(post.status()).toBe(405);
  expect(post.headers().allow).toBe("GET");
  await api.dispose();
});

test("the hall of fame lists the mocked entries in order", async ({ page }) => {
  const top = [
    { name: "Alpha", mass: 300, at: 1 },
    { name: "<b>Beta</b>", mass: 200, at: 2 },
    { name: "Gamma", mass: 100, at: 3 },
  ];
  await page.route("**/api/blobs/scores", (route) => route.fulfill({ json: { top, recent: [] } }));
  await page.goto("/blobs");
  await expect(page.locator("#blobs-scores h3")).toHaveText("Hall of fame");
  await expect(page.locator("#blobs-scores li")).toHaveCount(3);
  await expect(page.locator("#blobs-scores li").nth(0)).toContainText("Alpha");
  await expect(page.locator("#blobs-scores li").nth(1)).toContainText("<b>Beta</b>");
  await expect(page.locator("#blobs-scores li").nth(2)).toContainText("Gamma");
});

test("a failed fetch shows Scores unavailable", async ({ page }) => {
  await page.route("**/api/blobs/scores", (route) => route.fulfill({ status: 500, json: { error: "boom" } }));
  await page.goto("/blobs");
  await expect(page.locator("#blobs-scores")).toContainText("Scores unavailable");
});

test("the list refetches after you are eaten", async ({ page }) => {
  const me = { id: "abcd1234", name: "me", color: "#e74c3c", x: 500, y: 500, mass: 20, radius: 17.9, bot: false, peakMass: 33 };
  const eater = { ...me, id: "eeee0000", name: "Muncher", mass: 80, radius: 35.8 };
  const snapshot = { tick: 1, width: 2000, height: 2000, players: [me, eater], food: [[10, 10]] };
  let joined = false;
  let streamsAfterJoin = 0;
  let calls = 0;
  await page.route("**/api/blobs/scores", (route) => {
    calls += 1;
    if (calls === 1) return route.fulfill({ json: { top: [{ name: "First", mass: 50, at: 1 }], recent: [] } });
    if (calls === 2) return route.fulfill({ json: { top: [{ name: "Second", mass: 60, at: 2 }], recent: [] } });
    return route.fulfill({ status: 500, json: {} });
  });
  await page.route("**/api/blobs/join", (route) => {
    joined = true;
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(me) });
  });
  await page.route("**/api/blobs/stream", (route) => {
    let body = `retry: 100\n\nevent: state\ndata: ${JSON.stringify(snapshot)}\n\n`;
    // the first stream after joining only carries a snapshot, so the page draws you before you are eaten
    if (joined) streamsAfterJoin += 1;
    if (streamsAfterJoin === 2) body += `event: eaten\ndata: ${JSON.stringify({ eater, victim: me, at: new Date().toISOString() })}\n\n`;
    return route.fulfill({ status: 200, contentType: "text/event-stream", body });
  });
  await page.goto("/blobs");
  await expect(page.locator("#blobs-scores li")).toContainText("First");
  await page.waitForFunction(() => window.__blobs?.state);
  await page.fill("#blobs-name", "me");
  await page.click("#blobs-play");
  await page.waitForFunction(() => window.__blobs.me?.id === "abcd1234");
  await expect(page.locator("#blobs-scores li")).toContainText("Second");
  await expect(page.locator("#blobs-scores")).toContainText("Second");
});
