import { test, expect } from "@playwright/test";

const suffix = () => Math.random().toString(36).slice(2, 10);

async function newSite(request) {
  const res = await request.post("/api/pulse/sites", { data: { name: `Sources ${suffix()}` } });
  expect(res.status()).toBe(201);
  return res.json();
}

const collect = (request, site, path, referrer) =>
  request.post("/api/pulse/collect", { data: { site: site.id, path, referrer, visitor: `v${suffix()}${suffix()}` } });

async function seed(request, site) {
  for (let i = 0; i < 3; i++) await collect(request, site, "/pricing", "https://www.google.com/");
  await collect(request, site, "/", "https://google.com/x");
  await collect(request, site, "/pricing", "https://news.ycombinator.com/");
  await collect(request, site, "/");
}

test.describe("pulse sources plugin", () => {
  test("ranks pages and sources with proportional bars, refreshes and follows the range", async ({ page, request }) => {
    const site = await newSite(request);
    await seed(request, site);
    // /pricing 4, / 2; google.com 4, hacker news 1, direct 1
    await page.goto(`/pulse?site=${site.id}`);

    const pages = page.locator("#pulse-pages li.pulse-bar-row");
    await expect(pages).toHaveCount(2);
    await expect(pages.nth(0)).toHaveAttribute("data-key", "/pricing");
    await expect(pages.nth(0).locator(".pulse-row-value")).toHaveText("4");
    await expect(pages.nth(0)).toHaveAttribute("style", /--pulse-bar: 100%/);
    await expect(pages.nth(1)).toHaveAttribute("data-key", "/");
    await expect(pages.nth(1).locator(".pulse-row-value")).toHaveText("2");
    await expect(pages.nth(1)).toHaveAttribute("style", /--pulse-bar: 50%/);

    const refs = page.locator("#pulse-referrers li.pulse-bar-row");
    await expect(refs.first().locator(".pulse-row-key")).toHaveText("google.com");
    await expect(refs.first().locator(".pulse-row-value")).toHaveText("4");
    await expect(page.locator('#pulse-referrers li[data-key=""] .pulse-row-key')).toHaveText("Direct");

    const requests = [];
    page.on("request", (req) => req.url().includes("/breakdown") && requests.push(req.url()));
    await page.locator('#pulse-range button[data-range="30d"]').click();
    await expect.poll(() => requests.filter((u) => u.includes("range=30d") && u.includes("limit=8")).length).toBeGreaterThanOrEqual(2);
    expect(requests.some((u) => u.includes("by=page"))).toBe(true);
    expect(requests.some((u) => u.includes("by=referrer"))).toBe(true);

    await collect(request, site, "/", "https://google.com/");
    await page.evaluate(() => window.__pulse.refresh());
    await expect(pages.nth(1).locator(".pulse-row-value")).toHaveText("3");
  });

  test("exact bar percentages: 3 views vs 1 view", async ({ page, request }) => {
    const site = await newSite(request);
    for (let i = 0; i < 3; i++) await collect(request, site, "/pricing", "https://www.google.com/");
    await collect(request, site, "/", "https://google.com/x");
    await page.goto(`/pulse?site=${site.id}`);
    const pages = page.locator("#pulse-pages li.pulse-bar-row");
    await expect(pages.nth(0)).toHaveAttribute("style", /--pulse-bar: 100%/);
    await expect(pages.nth(1)).toHaveAttribute("style", /--pulse-bar: 33%/);
  });

  test("long paths are truncated with the full path in the title", async ({ page, request }) => {
    const site = await newSite(request);
    const path = `/${"very-long-segment-".repeat(12)}end`;
    await collect(request, site, path);
    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator("#pulse-pages .pulse-row-key")).toHaveAttribute("title", path);
  });

  test("an empty site shows No data yet in both cards", async ({ page, request }) => {
    const site = await newSite(request);
    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator('[data-plugin="sources"] .pulse-empty')).toHaveText(["No data yet", "No data yet"]);
  });

  test("a failing referrer breakdown only affects its own card", async ({ page, request }) => {
    const site = await newSite(request);
    await collect(request, site, "/pricing", "https://google.com/");
    await page.route("**/breakdown?by=referrer*", (route) => route.fulfill({ status: 500, json: { error: "boom" } }));
    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator('[data-plugin="sources"]').nth(1).locator(".pulse-empty")).toHaveText("Could not load");
    await expect(page.locator("#pulse-pages li.pulse-bar-row")).toHaveCount(1);
  });
});
