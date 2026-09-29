import { test, expect } from "@playwright/test";

const suffix = () => Math.random().toString(36).slice(2, 10);
const visitor = () => `v${suffix()}${suffix()}`;

async function newSite(request) {
  const res = await request.post("/api/pulse/sites", { data: { name: `Chart ${suffix()}` } });
  expect(res.status()).toBe(201);
  return res.json();
}

const collect = (request, site, v) => request.post("/api/pulse/collect", { data: { site: site.id, path: "/", visitor: v } });

const hits = (page) => page.locator("rect.pulse-chart-hit");
const tooltip = (page) => page.locator("#pulse-chart-tooltip");

test.describe("pulse traffic chart", () => {
  test("draws a target per bucket, shows a tooltip on hover and follows the range and refresh", async ({ page, request }) => {
    const site = await newSite(request);
    const a = visitor();
    for (const v of [a, a, visitor()]) await collect(request, site, v);

    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator('.pulse-card[data-plugin="chart"] .pulse-card-title')).toHaveText("Traffic");
    await expect(hits(page)).toHaveCount(24);
    const last = hits(page).last();
    await expect(last).toHaveAttribute("data-pageviews", "3");
    await expect(last).toHaveAttribute("data-visitors", "2");
    await expect(tooltip(page)).toBeHidden();

    await last.hover();
    await expect(tooltip(page)).toBeVisible();
    await expect(tooltip(page)).toContainText("3 pageviews");
    await expect(tooltip(page)).toContainText("2 visitors");
    await page.mouse.move(2, 2);
    await expect(tooltip(page)).toBeHidden();

    await page.locator('#pulse-range button[data-range="7d"]').click();
    await expect(hits(page)).toHaveCount(7);
    await page.locator('#pulse-range button[data-range="30d"]').click();
    await expect(hits(page)).toHaveCount(30);
    await page.locator('#pulse-range button[data-range="24h"]').click();
    await expect(hits(page)).toHaveCount(24);

    await collect(request, site, visitor());
    await page.evaluate(() => window.__pulse.refresh());
    await expect(hits(page).last()).toHaveAttribute("data-pageviews", "4");
  });

  test("a site without hits shows the axes and the empty state", async ({ page, request }) => {
    const site = await newSite(request);
    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator('.pulse-card[data-plugin="chart"] .pulse-empty')).toHaveText("No pageviews in this period");
    await expect(page.locator("#pulse-chart .pulse-chart-grid")).toHaveCount(4);
    await expect(hits(page)).toHaveCount(24);
  });

  test("arrow keys move the highlighted bucket", async ({ page, request }) => {
    const site = await newSite(request);
    await collect(request, site, visitor());
    await page.goto(`/pulse?site=${site.id}`);
    await expect(hits(page)).toHaveCount(24);
    await expect(page.locator("#pulse-chart")).toHaveAttribute("role", "img");
    await expect(page.locator("#pulse-chart")).toHaveAttribute("aria-label", /1 pageview from 1 visitor/);

    await page.locator("#pulse-chart").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(tooltip(page)).toBeVisible();
    await expect(tooltip(page)).toContainText("0 pageviews");
    await page.keyboard.press("ArrowRight");
    await expect(tooltip(page)).toContainText("1 pageview");
  });

  test("stays inside the viewport at 375 px", async ({ page, request }) => {
    const site = await newSite(request);
    await collect(request, site, visitor());
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/pulse?site=${site.id}&range=7d`);
    await expect(hits(page)).toHaveCount(7);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator("#pulse-chart").evaluate((svg) => svg.getBoundingClientRect().height)).toBe(180);

    const boxes = await page.locator("#pulse-chart text.x").evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect()).map((r) => [r.left, r.right]));
    for (let i = 1; i < boxes.length; i++) expect(boxes[i][0]).toBeGreaterThan(boxes[i - 1][1]);
  });
});
