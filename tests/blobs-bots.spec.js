import { test, expect } from "@playwright/test";
import { Arena } from "../src/blobs.js";
import { startBots } from "../src/blobs-bots.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function privateArena(over = {}) {
  const clock = { t: Date.parse("2026-01-01T00:00:00Z") };
  const a = new Arena({ foodCount: 0, now: () => clock.t, ...over });
  const run = (steps, dt = 50) => {
    for (let i = 0; i < steps; i += 1) {
      clock.t += dt;
      a.step(dt);
    }
  };
  return { a, clock, run };
}

const bots = (a) => a.snapshot().players.filter((p) => p.bot);

test.describe("blobs server-side bots", () => {
  test("startBots joins the requested number of bots", () => {
    const { a } = privateArena();
    const stop = startBots(a, { count: 3 });
    expect(bots(a)).toHaveLength(3);
    expect(new Set(bots(a).map((b) => b.name)).size).toBe(3);
    stop();
  });

  test("a bot walks to nearby food and never grows past 24", () => {
    const { a, run } = privateArena({ rng: () => 0.5 });
    const stop = startBots(a, { count: 1 });
    const bot = bots(a)[0];
    for (let i = 0; i < 40; i += 1) a.spawnFood(bot.x + 60 + i, bot.y);
    run(400);
    const after = a.get(bot.id);
    expect(after.mass).toBeGreaterThan(bot.mass);
    expect(after.mass).toBeLessThanOrEqual(24);
    expect(after.x).toBeGreaterThan(bot.x);
    stop();
  });

  test("a bot flees from a bigger player next to it", () => {
    const { a, run } = privateArena();
    const stop = startBots(a, { count: 1 });
    const bot = bots(a)[0];
    const human = a.join({ name: "big", x: Math.max(bot.x - 100, 0) + (bot.x < 100 ? 200 : 0), y: bot.y, mass: 40 });
    const before = Math.hypot(human.x - bot.x, human.y - bot.y);
    a.setTarget(human.id, human.x, human.y);
    run(6);
    const now = a.get(bot.id);
    expect(Math.hypot(human.x - now.x, human.y - now.y)).toBeGreaterThan(before);
    stop();
  });

  test("an eaten bot is replaced after respawnMs", async () => {
    const { a, run } = privateArena();
    const stop = startBots(a, { count: 1, respawnMs: 30 });
    const bot = bots(a)[0];
    a.join({ name: "big", x: bot.x, y: bot.y, mass: 40 });
    run(1);
    expect(bots(a)).toHaveLength(0);
    await sleep(100);
    expect(bots(a)).toHaveLength(1);
    expect(bots(a)[0].id).not.toBe(bot.id);
    stop();
  });

  test("bots are never removed as idle", () => {
    const { a, run } = privateArena({ idleMs: 1000 });
    const stop = startBots(a, { count: 2 });
    run(60, 1000);
    expect(bots(a)).toHaveLength(2);
    stop();
  });

  test("stop removes every bot and cancels pending respawns", async () => {
    const { a, run } = privateArena();
    const stop = startBots(a, { count: 2, respawnMs: 30 });
    const [first] = bots(a);
    a.join({ name: "big", x: first.x, y: first.y, mass: 40 });
    run(1);
    stop();
    expect(bots(a)).toHaveLength(0);
    await sleep(100);
    expect(bots(a)).toHaveLength(0);
  });

  test("the live arena always has at least one bot", async ({ request }) => {
    const state = await (await request.get("/api/blobs/state")).json();
    expect(state.players.some((p) => p.bot)).toBe(true);
  });
});
