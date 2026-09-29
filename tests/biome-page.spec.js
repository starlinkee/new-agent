import { test, expect } from "@playwright/test";

const MOCK_STATE = {
  tick: 1,
  width: 900,
  height: 900,
  sky: { time: 0.5, phase: "day", weather: "clear" },
  creatures: [
    { id: 9001, species: "herbivore", x: 300, y: 300, heading: 0.5, radius: 7, hue: 120, energy: 50, generation: 1, age: 3 },
    { id: 9002, species: "herbivore", x: 600, y: 420, heading: 2, radius: 7, hue: 30, energy: 50, generation: 1, age: 3 },
    { id: 9003, species: "predator", x: 450, y: 650, heading: -1, radius: 9, hue: 0, energy: 80, generation: 1, age: 5 },
  ],
  food: [
    [100, 100],
    [800, 200],
    [500, 500],
  ],
  effects: [],
  observers: [],
};

async function mockStream(page) {
  await page.route("**/api/biome/stream", (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
      body: `retry: 600000\n\nevent: state\ndata: ${JSON.stringify(MOCK_STATE)}\n\n`,
    }),
  );
}

async function openMocked(page) {
  await mockStream(page);
  await page.goto("/biome");
  await page.waitForFunction(() => window.__biome?.state?.tick === 1);
  await page.evaluate(() => {
    window.__picks = [];
    window.__biome.ctx.onPick((pick) => window.__picks.push(pick));
  });
}

test("the nav link reaches /biome", async ({ page }) => {
  await page.goto("/");
  await page.locator("#biome-link").click();
  await expect(page).toHaveURL(/\/biome$/);
  await expect(page.locator("#biome-canvas")).toBeVisible();
  await expect(page.locator("#biome-hud #biome-name-form #biome-name")).toHaveAttribute("maxlength", "16");
});

test("the page follows the live stream and observes as a guest, renaming survives a reload", async ({ page }) => {
  await page.goto("/biome");
  await page.waitForFunction(() => window.__biome?.state && window.__biome.me);
  expect(await page.evaluate(() => window.__biome.me.name)).toMatch(/^Guest-\d{4}$/);

  const name = `r${Math.random().toString(36).slice(2, 8)}`;
  await page.locator("#biome-name").fill(name);
  await page.locator("#biome-rename").click();
  await page.waitForFunction((n) => window.__biome.me?.name === n, name);

  await page.reload();
  await page.waitForFunction((n) => window.__biome?.me?.name === n, name);
});

test("dragging the canvas moves the camera and sends the pose", async ({ page }) => {
  await page.goto("/biome");
  await page.waitForFunction(() => window.__biome?.me);
  const before = await page.evaluate(() => window.__biome.camera.position.toArray());
  const box = await page.locator("#biome-canvas").boundingBox();
  const poseRequest = page.waitForRequest((req) => req.url().endsWith("/api/biome/pose") && req.method() === "POST", { timeout: 1500 });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  const request = await poseRequest;
  expect(Object.keys(request.postDataJSON()).sort()).toEqual(["pitch", "x", "y", "yaw", "z"]);
  const after = await page.evaluate(() => window.__biome.camera.position.toArray());
  expect(after).not.toEqual(before);
});

test("three is served from node_modules, anything else is 404", async ({ request }) => {
  const ok = await request.get("/vendor/three/build/three.module.min.js");
  expect(ok.status()).toBe(200);
  expect(ok.headers()["content-type"]).toContain("text/javascript");
  expect(ok.headers()["cache-control"]).toBe("public, max-age=86400");
  expect((await request.get("/vendor/three/addons/controls/OrbitControls.js")).status()).toBe(200);
  for (const path of [
    "/vendor/three/build/../../package.json",
    "/vendor/three/build/%2e%2e/%2e%2e/package.json",
    "/vendor/three/build/x.css",
    "/vendor/three/build/missing.js",
    "/vendor/other/x.js",
  ]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
  }
  expect(await (await request.get("/vendor/three/build/x.css")).json()).toEqual({ error: "not found" });
});

test("a mocked stream builds the scene, and clicks pick creatures or terrain", async ({ page }) => {
  await openMocked(page);
  const summary = await page.evaluate(() => {
    const { scene } = window.__biome;
    const creatures = scene.getObjectByName("biome-creatures");
    return {
      creatures: creatures.children.map((c) => ({ ...c.userData, geometry: c.geometry.type })),
      food: scene.getObjectByName("biome-food").children.length,
      terrain: !!scene.getObjectByName("biome-terrain"),
      lights: [scene.getObjectByName("biome-sun")?.isDirectionalLight, scene.getObjectByName("biome-ambient")?.isHemisphereLight],
    };
  });
  expect(summary.creatures).toEqual([
    { id: 9001, species: "herbivore", geometry: "SphereGeometry" },
    { id: 9002, species: "herbivore", geometry: "SphereGeometry" },
    { id: 9003, species: "predator", geometry: "ConeGeometry" },
  ]);
  expect(summary.food).toBe(3);
  expect(summary.terrain).toBe(true);
  expect(summary.lights).toEqual([true, true]);

  const click = async (x, y) => {
    const at = await page.evaluate(([sx, sy]) => window.__biome.toScreen(sx, sy), [x, y]);
    await page.mouse.click(at.x, at.y);
  };
  await click(300, 300);
  await click(450, 650);
  await click(150, 150);
  const picks = await page.evaluate(() => window.__picks);
  expect(picks.map((p) => p.creatureId)).toEqual([9001, 9003, null]);
  expect(Math.hypot(picks[2].point.x - 150, picks[2].point.y - 150)).toBeLessThan(15);
});

test("a drag on the canvas does not pick", async ({ page }) => {
  await openMocked(page);
  const at = await page.evaluate(() => window.__biome.toScreen(300, 300));
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 40, at.y + 10, { steps: 4 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.__picks)).toEqual([]);
});

test("without WebGL the status explains it and the scene still syncs", async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type === "webgl" || type === "webgl2" ? null : original.call(this, type, ...args);
    };
  });
  await openMocked(page);
  await expect(page.locator("#biome-status")).toHaveText("3D view unavailable: WebGL is disabled in this browser.");
  expect(await page.evaluate(() => window.__biome.webgl)).toBe(false);
  expect(await page.evaluate(() => window.__biome.scene.getObjectByName("biome-creatures").children.length)).toBe(3);
  const at = await page.evaluate(() => window.__biome.toScreen(300, 300));
  await page.mouse.click(at.x, at.y);
  expect((await page.evaluate(() => window.__picks))[0].creatureId).toBe(9001);
});

test("mountPlugins keeps going when a plugin throws", async ({ page }) => {
  await page.goto("/biome");
  await page.waitForFunction(() => window.__biome);
  const result = await page.evaluate(async () => {
    const { PLUGINS, mountPlugins } = await import("/static/biome/plugins/index.js");
    const log = [];
    PLUGINS.push({ mount: () => { throw new Error("boom"); } }, { mount: () => { log.push("mounted"); return () => log.push("cleaned"); } });
    let error = null;
    let cleanup;
    try {
      cleanup = mountPlugins(window.__biome.ctx);
      cleanup();
    } catch (err) {
      error = String(err);
    } finally {
      PLUGINS.length = 0;
    }
    return { error, log };
  });
  expect(result).toEqual({ error: null, log: ["mounted", "cleaned"] });
});
