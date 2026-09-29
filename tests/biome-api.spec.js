import { test, expect } from "@playwright/test";
import http from "node:http";
import { Biome, biome, readClientId, COOKIE_NAME, TICK_MS } from "../src/biome.js";
import { createBiomeStreamHandler } from "../src/biome-stream.js";

const uniqueName = () => `t${Math.random().toString(36).slice(2, 8)}`;
const HEX8 = /^[0-9a-f]{8}$/;
const PALETTE = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899"];

function collectEvents(url) {
  const events = [];
  const req = http.get(url, (res) => {
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
  return { events, close: () => req.destroy() };
}

test.describe("biome simulation", () => {
  test("module constants and cookie parsing", () => {
    expect(TICK_MS).toBe(100);
    expect(COOKIE_NAME).toBe("biome_client");
    expect(biome).toBeInstanceOf(Biome);
    const id = "a".repeat(32);
    expect(readClientId({ headers: { cookie: `x=1; ${COOKIE_NAME}=${id}` } })).toBe(id);
    expect(readClientId({ headers: { cookie: `${COOKIE_NAME}=short` } })).toBeNull();
    expect(readClientId({ headers: {} })).toBeNull();
  });

  test("step increments the tick and moves creatures", () => {
    const b = new Biome({ seed: 1 });
    const before = b.snapshot();
    b.step(100);
    const after = b.snapshot();
    expect(after.tick).toBe(before.tick + 1);
    const moved = after.creatures.some((c) => {
      const old = before.creatures.find((o) => o.id === c.id);
      return old && (old.x !== c.x || old.y !== c.y);
    });
    expect(moved).toBe(true);
  });

  test("the same seed gives identical snapshots after 50 steps", () => {
    const a = new Biome({ seed: 7 });
    const b = new Biome({ seed: 7 });
    for (let i = 0; i < 50; i++) {
      a.step(100);
      b.step(100);
    }
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  test("snapshot fields, rounding and sky", () => {
    const b = new Biome({ seed: 3 });
    b.step(100);
    const s = b.snapshot();
    expect(s).toMatchObject({ width: 900, height: 900 });
    expect(s.sky.time).toBeGreaterThanOrEqual(0);
    expect(s.sky.time).toBeLessThan(1);
    expect(["night", "dawn", "day", "dusk"]).toContain(s.sky.phase);
    expect(["clear", "rain", "snow"]).toContain(s.sky.weather);
    expect(s.creatures.length).toBeGreaterThan(0);
    expect(Object.keys(s.creatures[0]).sort()).toEqual(
      ["age", "energy", "generation", "heading", "hue", "id", "radius", "species", "x", "y"],
    );
    for (const [x, y] of s.food) {
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
    }
    for (const c of s.creatures) expect(c.x).toBe(Math.round(c.x * 10) / 10);
  });

  test("observers: join, pose clamping, rejoin, limit and idle expiry", () => {
    let now = 1_000_000;
    const b = new Biome({ seed: 1, idleMs: 5000, maxObservers: 2, now: () => now });
    const events = [];
    b.subscribe((e) => events.push(e));
    const cid = "c".repeat(32);
    const me = b.observe({ name: "me", clientId: cid });
    expect(me.id).toMatch(HEX8);
    expect(PALETTE).toContain(me.color);
    expect(me.pose).toEqual({ x: 0, y: 420, z: 520, yaw: 0, pitch: -0.7 });
    expect(b.observerOf(cid).id).toBe(me.id);

    expect(b.setPose("nope", me.pose)).toBe(false);
    expect(b.setPose(me.id, { x: 5000, y: 99999, z: -5000, yaw: 3 * Math.PI, pitch: 9 })).toBe(true);
    const pose = b.get(me.id).pose;
    expect(pose).toMatchObject({ x: 900, y: 2000, z: -900, pitch: 1.55 });
    expect(pose.yaw).toBeCloseTo(Math.PI, 2);
    b.setPose(me.id, { x: 0, y: 1, z: 0, yaw: -Math.PI, pitch: -9 });
    expect(b.get(me.id).pose).toMatchObject({ y: 5, pitch: -1.55 });
    expect(b.get(me.id).pose.yaw).toBeCloseTo(Math.PI, 2);

    const again = b.observe({ name: "me2", clientId: cid });
    expect(again.id).not.toBe(me.id);
    expect(b.get(me.id)).toBeUndefined();
    expect(events.find((e) => e.type === "left")).toMatchObject({ reason: "rejoin", observer: { id: me.id } });

    b.observe({ name: "other", clientId: "d".repeat(32) });
    expect(() => b.observe({ name: "third", clientId: "e".repeat(32) })).toThrow(/too many observers/);

    events.length = 0;
    now += 4000;
    b.setPose(again.id, { x: 1, y: 100, z: 1, yaw: 0, pitch: 0 });
    now += 2000;
    b.step(100);
    const left = events.filter((e) => e.type === "left");
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ reason: "idle", observer: { name: "other" } });
    expect(b.get(again.id)).toBeDefined();
  });

  test("publish reaches subscribers with `at` and rejects built-in types", () => {
    const b = new Biome({ seed: 1 });
    const got = [];
    b.subscribe(() => {
      throw new Error("bad listener");
    });
    b.subscribe((e) => got.push(e));
    const errors = console.error;
    console.error = () => {};
    try {
      b.publish({ type: "x-test", n: 1 });
    } finally {
      console.error = errors;
    }
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: "x-test", n: 1 });
    expect(new Date(got[0].at).toISOString()).toBe(got[0].at);
    expect(() => b.publish({ type: "tick" })).toThrow(TypeError);
    expect(() => b.publish({})).toThrow(TypeError);
  });

  test("a triggered event is announced exactly once and shows as an effect", () => {
    const b = new Biome({ seed: 1 });
    b.step(100);
    const happenings = [];
    b.subscribe((e) => e.type === "happening" && happenings.push(e));
    b.events.trigger(b.world, "meteor");
    b.step(100);
    expect(happenings).toHaveLength(1);
    expect(happenings[0]).toMatchObject({ eventType: "meteor" });
    expect(happenings[0].text).toMatch(/Meteor/);
    b.step(100);
    expect(happenings).toHaveLength(1);
    const meteor = b.snapshot().effects.find((e) => e.type === "meteor");
    expect(meteor).toBeTruthy();
    expect(typeof meteor.x).toBe("number");
    expect(typeof meteor.radius).toBe("number");
  });

  test("effects without a position have null coordinates", () => {
    const b = new Biome({ seed: 1 });
    b.events.trigger(b.world, "famine");
    const famine = b.snapshot().effects.find((e) => e.type === "famine");
    expect(famine).toMatchObject({ x: null, y: null, radius: null });
  });
});

test.describe("biome stream handler", () => {
  test("forwards published events as `event: <type>` without the type", async () => {
    const b = new Biome({ seed: 1 });
    const server = http.createServer(createBiomeStreamHandler(b));
    await new Promise((resolve) => server.listen(0, resolve));
    const { events, close } = collectEvents(`http://localhost:${server.address().port}/api/biome/stream`);
    try {
      await expect.poll(() => {
        b.publish({ type: "x-test", n: 1 });
        return events.some((e) => e.type === "x-test");
      }).toBe(true);
      const event = events.find((e) => e.type === "x-test");
      expect(event.data).toMatchObject({ n: 1 });
      expect("type" in event.data).toBe(false);
      expect(typeof event.data.at).toBe("string");
      b.step(100);
      await expect.poll(() => events.some((e) => e.type === "state")).toBe(true);
    } finally {
      close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test.describe("biome HTTP API", () => {
  const newClient = (playwright) => playwright.request.newContext({ baseURL: test.info().project.use.baseURL });

  test("observe, state, pose, leave and rejoin for one client", async ({ playwright }) => {
    const ctx = await newClient(playwright);
    const name = uniqueName();
    try {
      const res = await ctx.post("/api/biome/observe", { data: { name: `  ${name} ` } });
      expect(res.status()).toBe(201);
      expect(res.headers()["set-cookie"]).toMatch(/^biome_client=[0-9a-f]{32}; .*HttpOnly.*SameSite=Lax/i);
      const me = await res.json();
      expect(me).toMatchObject({ name, pose: { x: 0, y: 420, z: 520, yaw: 0, pitch: -0.7 } });
      expect(me.id).toMatch(HEX8);
      expect(PALETTE).toContain(me.color);

      let state = await (await ctx.get("/api/biome/state")).json();
      expect(state.me).toBe(me.id);
      expect(typeof state.tick).toBe("number");
      expect(state).toMatchObject({ width: 900, height: 900 });
      expect(state.sky).toEqual({ time: expect.any(Number), phase: expect.any(String), weather: expect.any(String) });
      for (const key of ["creatures", "food", "effects", "observers"]) expect(Array.isArray(state[key])).toBe(true);
      expect(state.observers.find((o) => o.id === me.id)).toMatchObject({ name });

      const pose = await ctx.post("/api/biome/pose", { data: { x: 10, y: 99999, z: -20, yaw: 1, pitch: 0.5 } });
      expect(pose.status()).toBe(204);
      state = await (await ctx.get("/api/biome/state")).json();
      expect(state.observers.find((o) => o.id === me.id).pose).toEqual({ x: 10, y: 2000, z: -20, yaw: 1, pitch: 0.5 });

      const bad = await ctx.post("/api/biome/pose", { data: { x: "a", y: 1, z: 1, yaw: 0, pitch: 0 } });
      expect(bad.status()).toBe(400);
      expect((await ctx.post("/api/biome/pose", { data: { x: 1, y: 1, z: 1, yaw: 0 } })).status()).toBe(400);

      const second = await (await ctx.post("/api/biome/observe", { data: { name } })).json();
      state = await (await ctx.get("/api/biome/state")).json();
      expect(state.me).toBe(second.id);
      expect(state.observers.filter((o) => o.name === name)).toHaveLength(1);

      expect((await ctx.post("/api/biome/leave")).status()).toBe(204);
      state = await (await ctx.get("/api/biome/state")).json();
      expect(state.me).toBeNull();
      expect(state.observers.some((o) => o.id === second.id)).toBe(false);
      expect((await ctx.post("/api/biome/leave")).status()).toBe(204);
    } finally {
      await ctx.dispose();
    }
  });

  test("invalid names are 400 and pose without observing is 404", async ({ playwright }) => {
    const ctx = await newClient(playwright);
    try {
      for (const name of ["   ", "", "x".repeat(17), 5]) {
        expect((await ctx.post("/api/biome/observe", { data: { name } })).status(), String(name)).toBe(400);
      }
      const res = await ctx.post("/api/biome/pose", { data: { x: 0, y: 10, z: 0, yaw: 0, pitch: 0 } });
      expect(res.status()).toBe(404);
      expect(await res.json()).toEqual({ error: "not observing" });
    } finally {
      await ctx.dispose();
    }
  });

  test("wrong methods are 405 with Allow, oversized bodies 413", async ({ request }) => {
    const cases = [
      ["get", "/api/biome/observe", "POST"],
      ["get", "/api/biome/pose", "POST"],
      ["put", "/api/biome/leave", "POST"],
      ["post", "/api/biome/state", "GET"],
      ["post", "/api/biome/stream", "GET"],
    ];
    for (const [method, path, allow] of cases) {
      const res = await request[method](path);
      expect(res.status(), `${method} ${path}`).toBe(405);
      expect(res.headers().allow).toBe(allow);
    }
    const big = await request.post("/api/biome/observe", { data: { name: "x".repeat(2000) } });
    expect(big.status()).toBe(413);
  });

  test("the live stream delivers state, then joined and left for my own observer", async ({ playwright, baseURL }) => {
    const { events, close } = collectEvents(`${baseURL}/api/biome/stream`);
    const ctx = await newClient(playwright);
    try {
      await expect.poll(() => events.filter((e) => e.type === "state").length, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
      const me = await (await ctx.post("/api/biome/observe", { data: { name: uniqueName() } })).json();
      await expect.poll(() => events.some((e) => e.type === "joined" && e.data.observer.id === me.id)).toBe(true);
      await ctx.post("/api/biome/leave");
      await expect
        .poll(() => events.some((e) => e.type === "left" && e.data.observer.id === me.id && e.data.reason === "leave"))
        .toBe(true);
      const state = events.find((e) => e.type === "state").data;
      expect(state).toMatchObject({ width: 900, height: 900 });
      expect("type" in events.find((e) => e.type === "joined").data).toBe(false);
    } finally {
      close();
      await ctx.dispose();
    }
  });
});
