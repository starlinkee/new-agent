import { test, expect } from "@playwright/test";

const uniqueName = () => `t${Math.random().toString(36).slice(2, 8)}`;

test("the nav link reaches /blobs", async ({ page }) => {
  await page.goto("/");
  await page.click("#blobs-link");
  await expect(page).toHaveURL(/\/blobs$/);
  await expect(page.locator("#blobs-canvas")).toBeVisible();
});

test("the arena is visible before joining and no target is sent", async ({ page }) => {
  const targets = [];
  page.on("request", (req) => req.url().endsWith("/api/blobs/target") && targets.push(req));
  await page.goto("/blobs");
  await page.waitForFunction(() => window.__blobs?.state?.players);
  await page.mouse.move(300, 300);
  await page.mouse.move(400, 350);
  await page.waitForTimeout(400);
  expect(targets).toHaveLength(0);
  expect(await page.evaluate(() => window.__blobs.me)).toBeNull();
});

test("join, steer with the mouse, and leave", async ({ page }) => {
  const name = uniqueName();
  await page.goto("/blobs");
  await page.waitForFunction(() => window.__blobs?.state);
  await page.fill("#blobs-name", name);
  await page.click("#blobs-play");
  await expect(page.locator("#blobs-join")).toBeHidden();
  await page.waitForFunction((n) => window.__blobs.me?.name === n, name);

  const startX = await page.evaluate(() => window.__blobs.me.x);
  const dir = startX < 1000 ? 1 : -1;
  const box = await page.locator("#blobs-canvas").boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const request = page.waitForRequest((r) => r.url().endsWith("/api/blobs/target"));
  await page.mouse.move(cx, cy);
  await page.mouse.move(cx + 200 * dir, cy);
  await request;
  await expect
    .poll(async () => ((await page.evaluate(() => window.__blobs.me?.x)) - startX) * dir, { timeout: 3000 })
    .toBeGreaterThan(5);
  await page.evaluate(() => window.__blobs.leave());
});

test("a blank name shows the server error and keeps the form", async ({ page }) => {
  await page.goto("/blobs");
  await page.click("#blobs-play");
  await expect(page.locator("#blobs-status")).not.toBeEmpty();
  await expect(page.locator("#blobs-join")).toBeVisible();
});

test("being eaten shows the death screen and Play again", async ({ page }) => {
  const me = { id: "abcd1234", name: "me", color: "#e74c3c", x: 500, y: 500, mass: 20, radius: 17.9, bot: false, peakMass: 33 };
  const eater = { ...me, id: "eeee0000", name: "Muncher", mass: 80, radius: 35.8 };
  const snapshot = { tick: 1, width: 2000, height: 2000, players: [me, eater], food: [[10, 10]] };
  let joined = false;
  await page.route("**/api/blobs/join", (route) => {
    joined = true;
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(me) });
  });
  await page.route("**/api/blobs/stream", (route) => {
    let body = `retry: 100\n\nevent: state\ndata: ${JSON.stringify(snapshot)}\n\n`;
    if (joined) body += `event: eaten\ndata: ${JSON.stringify({ eater, victim: me, at: new Date().toISOString() })}\n\n`;
    return route.fulfill({ status: 200, contentType: "text/event-stream", body });
  });
  await page.goto("/blobs");
  await page.waitForFunction(() => window.__blobs?.state);
  await page.fill("#blobs-name", "me");
  await page.click("#blobs-play");
  await expect(page.locator("#blobs-dead")).toContainText("Eaten by Muncher");
  await expect(page.locator("#blobs-dead")).toContainText("33");
  await expect(page.locator("#blobs-play")).toHaveText("Play again");
  await expect(page.locator("#blobs-join")).toBeVisible();
});

test("mountPlugins keeps going when a plugin throws", async ({ page }) => {
  await page.goto("/blobs");
  const mounted = await page.evaluate(async () => {
    const { PLUGINS, mountPlugins } = await import("/static/blobs/plugins/index.js");
    let recorded = false;
    PLUGINS.push({ mount() { throw new Error("boom"); } }, { mount() { recorded = true; } });
    mountPlugins({});
    return recorded;
  });
  expect(mounted).toBe(true);
});
