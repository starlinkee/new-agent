import { test, expect } from "@playwright/test";
import http from "node:http";
import { Arena } from "../src/blobs.js";

const suffix = () => Math.random().toString(36).slice(2, 8);
const uniqueName = () => `t${suffix()}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const privateArena = (over = {}) => new Arena({ foodCount: 0, ...over });

test.describe("blobs arena rules", () => {
  test("a player moves toward its target by the expected distance and stops there", () => {
    const a = privateArena();
    const p = a.join({ name: "p", x: 100, y: 100, mass: 20 });
    expect(p.radius).toBe(17.9);
    a.setTarget(p.id, 300, 100);
    a.step(1000);
    expect(a.get(p.id).x).toBe(300);
    const q = a.join({ name: "q", x: 100, y: 500, mass: 20 });
    a.setTarget(q.id, 1000, 500);
    a.step(500);
    expect(a.get(q.id).x).toBeCloseTo(100 + 120, 1);
    expect(a.get(q.id).y).toBe(500);
    a.setTarget(q.id, 5000, -5000);
    a.step(60_000);
    expect(a.get(q.id)).toMatchObject({ x: 2000, y: 0 });
  });

  test("heavier players are slower", () => {
    const a = privateArena();
    const light = a.join({ name: "l", x: 0, y: 0, mass: 20 });
    const heavy = a.join({ name: "h", x: 0, y: 1000, mass: 320 });
    a.setTarget(light.id, 1000, 0);
    a.setTarget(heavy.id, 1000, 1000);
    a.step(1000);
    expect(a.get(heavy.id).x).toBeCloseTo(240 * (20 / 320) ** 0.4, 1);
    expect(a.get(heavy.id).x).toBeLessThan(a.get(light.id).x);
  });

  test("food within the radius is eaten for +1 mass, food further away stays", () => {
    const a = privateArena();
    const p = a.join({ name: "p", x: 500, y: 500, mass: 20 });
    a.spawnFood(510, 500);
    a.spawnFood(500, 500 + Math.ceil(p.radius) + 10);
    a.step(50);
    expect(a.get(p.id).mass).toBe(21);
    expect(a.snapshot().food).toHaveLength(1);
  });

  test("food is refilled to foodCount", () => {
    const a = new Arena({ foodCount: 30 });
    expect(a.snapshot().food).toHaveLength(30);
    const p = a.join({ name: "p", x: 1000, y: 1000 });
    a.spawnFood(1000, 1000);
    a.step(50);
    expect(a.snapshot().food.length).toBeGreaterThanOrEqual(30);
    expect(a.get(p.id)).toBeTruthy();
  });

  test("mass 30 eats mass 20 at the same spot; 24 vs 20 eats nothing", () => {
    const a = privateArena();
    const events = [];
    a.subscribe((e) => events.push(e));
    const big = a.join({ name: "big", x: 400, y: 400, mass: 30 });
    const small = a.join({ name: "small", x: 400, y: 400, mass: 20 });
    a.step(50);
    const eaten = events.filter((e) => e.type === "eaten");
    expect(eaten).toHaveLength(1);
    expect(eaten[0].eater.id).toBe(big.id);
    expect(eaten[0].victim.id).toBe(small.id);
    expect(eaten[0].victim.peakMass).toBe(20);
    expect(new Date(eaten[0].at).toISOString()).toBe(eaten[0].at);
    expect(a.get(big.id).mass).toBe(50);
    expect(a.get(small.id)).toBeUndefined();

    const b = privateArena();
    const p1 = b.join({ name: "a", x: 400, y: 400, mass: 24 });
    const p2 = b.join({ name: "b", x: 400, y: 400, mass: 20 });
    b.step(50);
    expect(b.get(p1.id).mass).toBe(24);
    expect(b.get(p2.id).mass).toBe(20);
  });

  test("maxMass caps growth", () => {
    const a = privateArena();
    const p = a.join({ name: "p", x: 100, y: 100, mass: 20, maxMass: 25 });
    for (let i = 0; i < 10; i++) a.spawnFood(100, 100);
    a.step(50);
    expect(a.get(p.id).mass).toBe(25);
    const prey = a.join({ name: "prey", x: 100, y: 100, mass: 10 });
    a.step(50);
    expect(a.get(prey.id)).toBeUndefined();
    expect(a.get(p.id).mass).toBe(25);
  });

  test("an idle human leaves with reason idle, a bot does not, input resets the timer", () => {
    let t = 1_000_000;
    const a = privateArena({ idleMs: 30_000, now: () => t });
    const events = [];
    a.subscribe((e) => events.push(e));
    const human = a.join({ name: "h", x: 10, y: 10 });
    const active = a.join({ name: "active", x: 900, y: 900 });
    const bot = a.join({ name: "bot", bot: true, x: 1500, y: 1500 });
    t += 20_000;
    expect(a.setTarget(active.id, 950, 950)).toBe(true);
    expect(a.setTarget("nope", 1, 1)).toBe(false);
    t += 20_000;
    a.step(50);
    const left = events.filter((e) => e.type === "left");
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ reason: "idle" });
    expect(left[0].player.id).toBe(human.id);
    expect(a.get(human.id)).toBeUndefined();
    expect(a.get(active.id)).toBeTruthy();
    expect(a.get(bot.id)).toBeTruthy();
  });

  test("maxPlayers limits humans with 503 and bots do not count", () => {
    const a = privateArena({ maxPlayers: 2 });
    a.join({ name: "a" });
    a.join({ name: "b" });
    a.join({ name: "bot", bot: true });
    expect(() => a.join({ name: "c" })).toThrow(expect.objectContaining({ status: 503, message: "arena full" }));
    expect(() => a.join({ name: "bot2", bot: true })).not.toThrow();
  });

  test("peakMass survives in the left event; views are shaped and colours come from the palette", () => {
    const a = privateArena();
    const events = [];
    a.subscribe((e) => events.push(e));
    const p = a.join({ name: "p", x: 100, y: 100, mass: 20 });
    expect(p).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}$/),
      name: "p",
      color: expect.stringMatching(/^#[0-9a-f]{6}$/),
      x: 100,
      y: 100,
      mass: 20,
      radius: 17.9,
      bot: false,
      peakMass: 20,
    });
    a.spawnFood(100, 100);
    a.spawnFood(100, 100);
    a.step(50);
    a.leave(p.id);
    const left = events.find((e) => e.type === "left");
    expect(left.player.mass).toBe(22);
    expect(left.player.peakMass).toBe(22);
    expect(left.reason).toBe("leave");
    expect(events.filter((e) => e.type === "tick")).toHaveLength(1);
  });

  test("a throwing listener does not stop the others; unsubscribe works", () => {
    const a = privateArena();
    const seen = [];
    const errors = console.error;
    console.error = () => {};
    try {
      a.subscribe(() => {
        throw new Error("boom");
      });
      const off = a.subscribe((e) => seen.push(e.type));
      a.step(50);
      off();
      a.step(50);
    } finally {
      console.error = errors;
    }
    expect(seen).toEqual(["tick"]);
  });
});

test.describe("blobs HTTP API", () => {
  const newClient = (playwright) => playwright.request.newContext({ baseURL: test.info().project.use.baseURL });

  test("join, state, target, leave and rejoin for one client", async ({ playwright }) => {
    const ctx = await newClient(playwright);
    const name = uniqueName();
    const joined = await ctx.post("/api/blobs/join", { data: { name: `  ${name}  ` } });
    expect(joined.status()).toBe(201);
    expect(joined.headers()["set-cookie"]).toMatch(/^blobs_client=[0-9a-f]{32}; .*HttpOnly.*SameSite=Lax/i);
    const me = await joined.json();
    expect(me).toMatchObject({ name, bot: false, mass: 20 });
    expect(me.id).toMatch(/^[0-9a-f]{8}$/);

    let state = await (await ctx.get("/api/blobs/state")).json();
    expect(state.me).toBe(me.id);
    expect(state.players.find((p) => p.id === me.id)).toMatchObject({ name });
    expect(state).toMatchObject({ width: 2000, height: 2000 });
    expect(state.food[0]).toHaveLength(2);

    const before = state.players.find((p) => p.id === me.id);
    const target = { x: before.x < 1000 ? before.x + 400 : before.x - 400, y: before.y };
    expect((await ctx.post("/api/blobs/target", { data: target })).status()).toBe(204);
    await sleep(1000);
    state = await (await ctx.get("/api/blobs/state")).json();
    const after = state.players.find((p) => p.id === me.id);
    expect(Math.abs(after.x - target.x)).toBeLessThan(Math.abs(before.x - target.x) - 100);

    const second = await (await ctx.post("/api/blobs/join", { data: { name: uniqueName() } })).json();
    expect(second.id).not.toBe(me.id);
    state = await (await ctx.get("/api/blobs/state")).json();
    expect(state.me).toBe(second.id);
    expect(state.players.some((p) => p.id === me.id)).toBe(false);

    expect((await ctx.post("/api/blobs/leave")).status()).toBe(204);
    state = await (await ctx.get("/api/blobs/state")).json();
    expect(state.me).toBeNull();
    expect(state.players.some((p) => p.id === second.id)).toBe(false);
    expect((await ctx.post("/api/blobs/leave")).status()).toBe(204);
    await ctx.dispose();
  });

  test("bad names and bad targets are 400, target without playing is 404", async ({ playwright }) => {
    const ctx = await newClient(playwright);
    for (const name of ["", "   ", "x".repeat(17), 5, undefined]) {
      const res = await ctx.post("/api/blobs/join", { data: { name } });
      expect(res.status()).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    const notPlaying = await ctx.post("/api/blobs/target", { data: { x: 1, y: 1 } });
    expect(notPlaying.status()).toBe(404);
    expect(await notPlaying.json()).toEqual({ error: "not playing" });

    await ctx.post("/api/blobs/join", { data: { name: uniqueName() } });
    for (const data of [{ x: "1", y: 2 }, { x: 1 }, { x: null, y: 2 }, { x: 1, y: [] }]) {
      expect((await ctx.post("/api/blobs/target", { data })).status()).toBe(400);
    }
    const big = await ctx.post("/api/blobs/target", { data: { x: 1, y: 1, pad: "z".repeat(2000) } });
    expect(big.status()).toBe(413);
    await ctx.post("/api/blobs/leave");
    await ctx.dispose();
  });

  test("wrong methods are 405 with Allow", async ({ request }) => {
    const cases = [
      ["get", "/api/blobs/join", "POST"],
      ["get", "/api/blobs/target", "POST"],
      ["put", "/api/blobs/leave", "POST"],
      ["post", "/api/blobs/state", "GET"],
      ["post", "/api/blobs/stream", "GET"],
    ];
    for (const [method, path, allow] of cases) {
      const res = await request[method](path);
      expect(res.status(), `${method} ${path}`).toBe(405);
      expect(res.headers().allow).toBe(allow);
    }
  });

  test("unknown blobs routes are not handled by this module", async ({ request }) => {
    expect((await request.get("/api/blobs/unknown-route")).status()).not.toBe(200);
  });
});

test.describe("blobs stream", () => {
  test("state events tick upward and another client's join arrives as a joined event", async ({ playwright, baseURL }) => {
    const events = [];
    const req = http.get(`${baseURL}/api/blobs/stream`, (res) => {
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type && data) events.push({ type, data: JSON.parse(data) });
        }
      });
    });
    const ctx = await playwright.request.newContext({ baseURL });
    const name = uniqueName();
    try {
      await expect.poll(() => events.filter((e) => e.type === "state").length, { timeout: 5000 }).toBeGreaterThanOrEqual(3);
      const joined = await (await ctx.post("/api/blobs/join", { data: { name } })).json();
      await expect.poll(() => events.find((e) => e.type === "joined" && e.data.player.name === name)).toBeTruthy();
      const event = events.find((e) => e.type === "joined" && e.data.player.name === name);
      expect(event.data.player.id).toBe(joined.id);
      expect("type" in event.data).toBe(false);
      await ctx.post("/api/blobs/leave");
      await expect
        .poll(() => events.some((e) => e.type === "left" && e.data.player.id === joined.id && e.data.reason === "leave"))
        .toBe(true);
    } finally {
      req.destroy();
      await ctx.dispose();
    }
    const ticks = events.filter((e) => e.type === "state").map((e) => e.data.tick);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    expect(events.find((e) => e.type === "state").data).toMatchObject({ width: 2000, height: 2000 });
  });
});
