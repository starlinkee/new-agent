import { test, expect } from "@playwright/test";

const suffix = () => Math.random().toString(36).slice(2, 10);

async function newSite(request) {
  const res = await request.post("/api/pulse/sites", { data: { name: `Devices ${suffix()}` } });
  expect(res.status()).toBe(201);
  return res.json();
}

const collect = (request, site, width) =>
  request.post("/api/pulse/collect", { data: { site: site.id, path: "/", visitor: `v${suffix()}${suffix()}`, width } });

const legendRow = (page, device) => page.locator(`li.pulse-device[data-device="${device}"]`);

test.describe("pulse devices card", () => {
  test("splits pageviews by device with a legend and the total in the centre", async ({ page, request }) => {
    const site = await newSite(request);
    for (const width of [1280, 1280, 400, 800]) expect((await collect(request, site, width)).status()).toBe(202);

    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator("#pulse-devices path.pulse-device-slice")).toHaveCount(3);
    await expect(page.locator(".pulse-devices-total")).toHaveText("4");
    await expect(legendRow(page, "desktop").locator(".pulse-device-name")).toHaveText("Desktop");
    await expect(legendRow(page, "desktop").locator(".pulse-device-count")).toHaveText("2");
    await expect(legendRow(page, "desktop").locator(".pulse-device-percent")).toHaveText("50%");
    await expect(legendRow(page, "mobile").locator(".pulse-device-count")).toHaveText("1");
    await expect(legendRow(page, "mobile").locator(".pulse-device-percent")).toHaveText("25%");
    await expect(legendRow(page, "tablet").locator(".pulse-device-count")).toHaveText("1");
    await expect(legendRow(page, "tablet").locator(".pulse-device-percent")).toHaveText("25%");
    await expect(page.locator("li.pulse-device")).toHaveCount(3);
    await expect(page.locator("path.pulse-device-slice")).toHaveCount(3);
  });

  test("hovering a legend row emphasises its slice", async ({ page, request }) => {
    const site = await newSite(request);
    for (const width of [1280, 400]) await collect(request, site, width);

    await page.goto(`/pulse?site=${site.id}`);
    await legendRow(page, "mobile").hover();
    await expect(page.locator('path.pulse-device-slice[data-device="mobile"]')).toHaveClass(/is-active/);
    await expect(page.locator('path.pulse-device-slice[data-device="desktop"]')).not.toHaveClass(/is-active/);
  });

  test("a single device draws one slice", async ({ page, request }) => {
    const site = await newSite(request);
    await collect(request, site, 1280);
    await collect(request, site, 1500);

    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator("#pulse-devices path.pulse-device-slice")).toHaveCount(1);
    await expect(page.locator('path.pulse-device-slice[data-device="desktop"]')).toBeVisible();
    await expect(legendRow(page, "desktop").locator(".pulse-device-percent")).toHaveText("100%");
  });

  test("an empty site shows No data yet", async ({ page, request }) => {
    const site = await newSite(request);
    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator('[data-plugin="devices"] .pulse-empty')).toHaveText("No data yet");
    await expect(page.locator("path.pulse-device-slice")).toHaveCount(0);
  });

  test("refresh picks up new hits", async ({ page, request }) => {
    const site = await newSite(request);
    await collect(request, site, 1280);

    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator(".pulse-devices-total")).toHaveText("1");
    await collect(request, site, 400);
    await page.evaluate(() => window.__pulse.refresh());
    await expect(page.locator(".pulse-devices-total")).toHaveText("2");
    await expect(page.locator("path.pulse-device-slice")).toHaveCount(2);
  });

  test("has no horizontal overflow at 375px", async ({ page, request }) => {
    const site = await newSite(request);
    for (const width of [1280, 400, 800]) await collect(request, site, width);

    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator("path.pulse-device-slice")).toHaveCount(3);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
