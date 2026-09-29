import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { PulseStore } from "../src/pulse.js";
import { createPulseLiveHandler } from "../src/pulse-live.js";

const suffix = () => Math.random().toString(36).slice(2, 10);
const visitor = () => `v${suffix()}${suffix()}`;

async function newSite(request) {
  const res = await request.post("/api/pulse/sites", { data: { name: `Live ${suffix()}` } });
  expect(res.status()).toBe(201);
  return res.json();
}

const collect = async (request, site, v, path = "/") => {
  const res = await request.post("/api/pulse/collect", { data: { site: site.id, path, visitor: v } });
  expect(res.status()).toBe(202);
};

test.describe("pulse realtime", () => {
  test("an empty site shows the waiting state and 0 online", async ({ page, request }) => {
    const site = await newSite(request);
    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator("#pulse-live-count")).toHaveText("0 online");
    await expect(page.locator("#pulse-live-feed .pulse-live-item")).toHaveCount(0);
    await expect(page.locator(".pulse-card[data-plugin='live'] .pulse-empty")).toHaveText("Waiting for visitors…");
  });

  test("hits appear live: online count, feed and KPIs update without reload", async ({ page, request }) => {
    const site = await newSite(request);
    const other = await newSite(request);
    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator("#pulse-live-count")).toHaveText("0 online");
    const views = page.locator('.pulse-kpi[data-kpi="pageviews"] .pulse-kpi-value');
    await expect(views).toHaveText("0");

    const first = visitor();
    await collect(request, site, first, "/first-page");
    await expect(page.locator("#pulse-live-count")).toHaveText("1 online");
    await expect(page.locator("#pulse-live-feed li").first()).toContainText("/first-page");
    await expect(page.locator(".pulse-card[data-plugin='live'] .pulse-empty")).toBeHidden();
    await expect(page.locator("#pulse-live-feed li").first()).toContainText("just now");
    await expect(views).toHaveText("1");

    await collect(request, site, visitor(), "/second-page");
    await expect(page.locator("#pulse-live-count")).toHaveText("2 online");
    await expect(page.locator("#pulse-live-feed li").first()).toContainText("/second-page");

    await collect(request, site, first, "/third-page");
    await expect(page.locator("#pulse-live-feed li").first()).toContainText("/third-page");
    await expect(page.locator("#pulse-live-count")).toHaveText("2 online");
    await expect(views).toHaveText("3");

    await collect(request, other, visitor(), "/elsewhere");
    await collect(request, site, visitor(), "/sync");
    await expect(page.locator("#pulse-live-count")).toHaveText("3 online");
    await expect(page.locator("#pulse-live-feed")).not.toContainText("/elsewhere");
    await expect(page.locator("#pulse-live-feed li")).toHaveCount(4);
  });

  test("the feed keeps at most 10 items and the snapshot fills it on load", async ({ page, request }) => {
    const site = await newSite(request);
    for (let i = 0; i < 12; i++) await collect(request, site, visitor(), `/p${i}`);
    await page.goto(`/pulse?site=${site.id}`);
    const items = page.locator("#pulse-live-feed .pulse-live-item");
    await expect(items).toHaveCount(10);
    await expect(items.first()).toContainText("/p11");
    await expect(page.locator("#pulse-live-count")).toHaveText("12 online");
    await collect(request, site, visitor(), "/p12");
    await expect(items.first()).toContainText("/p12");
    await expect(items).toHaveCount(10);
    await expect(items.first()).toHaveClass(/is-new/);
  });

  test("the widget shows Reconnecting… while the stream is down", async ({ page, request }) => {
    const site = await newSite(request);
    await page.route(`**/api/pulse/sites/${site.id}/live`, (route) => route.abort());
    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator("#pulse-live")).toHaveClass(/offline/);
    await expect(page.locator("#pulse-live-count")).toHaveText("Reconnecting…");
  });

  test("the live endpoint answers 404 for unknown sites and 405 for other methods", async ({ request }) => {
    const missing = await request.get("/api/pulse/sites/0000000000/live");
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual({ error: "site not found" });
    const post = await request.post("/api/pulse/sites/0000000000/live", { data: {} });
    expect(post.status()).toBe(405);
    expect(post.headers().allow).toBe("GET");
  });

  test("visitors older than activeWindowMs are not counted as active", async () => {
    let now = Date.parse("2026-01-01T12:00:00Z");
    const store = new PulseStore({ now: () => now });
    const site = store.createSite({ name: "Clock" });
    const record = (v) => store.record(site.id, { path: "/", referrer: null, device: "desktop", visitor: v });
    record("old");
    now += 200_000;
    record("recent");
    now += 150_000; // "old" is 350 s back, "recent" 150 s
    const server = createServer((req, res) => createPulseLiveHandler(store, { pingMs: 60_000, activeWindowMs: 300_000 })(req, res));
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/pulse/sites/${site.id}/live`);
      const reader = res.body.getReader();
      let text = "";
      while (!text.includes("event: snapshot\ndata: ") || !text.endsWith("\n\n")) {
        text += new TextDecoder().decode((await reader.read()).value);
      }
      await reader.cancel();
      const data = JSON.parse(text.split("event: snapshot\ndata: ")[1].split("\n")[0]);
      expect(data.active).toBe(1);
      expect(data.recent).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
