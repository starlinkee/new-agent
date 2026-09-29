import { test, expect } from "@playwright/test";

const suffix = () => Math.random().toString(36).slice(2, 10);
const visitor = () => `v${suffix()}${suffix()}`;

async function newSite(request) {
  const res = await request.post("/api/pulse/sites", { data: { name: `Site ${suffix()}` } });
  expect(res.status()).toBe(201);
  return res.json();
}

const collect = (request, site, v, path = "/") =>
  request.post("/api/pulse/collect", { data: { site: site.id, path, visitor: v } });

const summaryStub = (site, over = {}) => ({
  site,
  range: "24h",
  from: new Date(Date.now() - 864e5).toISOString(),
  to: new Date().toISOString(),
  pageviews: 0,
  visitors: 0,
  previous: { pageviews: 0, visitors: 0 },
  series: [],
  ...over,
});

const kpi = (page, name, part) => page.locator(`.pulse-kpi[data-kpi="${name}"] .pulse-kpi-${part}`);

test.describe("pulse landing", () => {
  test("nav link reaches /pulse, creating a site opens its dashboard and lists it", async ({ page }) => {
    await page.goto("/");
    await page.locator("#pulse-link").click();
    await expect(page).toHaveURL(/\/pulse$/);
    await expect(page.locator("h1")).toHaveText("Pulse");

    const name = `Landing ${suffix()}`;
    await page.fill("#pulse-site-name", name);
    await page.fill("#pulse-site-domain", "Example.com");
    await page.click("#pulse-site-create");
    await expect(page).toHaveURL(/\/pulse\?site=[0-9a-f]{10}$/);
    await expect(page.locator("#pulse-site-title")).toHaveText(name);

    await page.goto("/pulse");
    await expect(page.locator("#pulse-sites a.pulse-site-link", { hasText: name })).toBeVisible();
  });

  test("a bad domain shows the server error", async ({ page }) => {
    await page.goto("/pulse");
    await page.fill("#pulse-site-name", `Bad ${suffix()}`);
    await page.fill("#pulse-site-domain", "not a domain!");
    await page.click("#pulse-site-create");
    await expect(page.locator("#pulse-site-error")).not.toBeEmpty();
    await expect(page).toHaveURL(/\/pulse$/);
  });
});

test.describe("pulse dashboard", () => {
  test("KPIs show collected hits and refresh without a reload", async ({ page, request }) => {
    const site = await newSite(request);
    const a = visitor();
    const b = visitor();
    for (const v of [a, a, b]) await collect(request, site, v);

    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator("#pulse-site-title")).toHaveText(site.name);
    await expect(kpi(page, "pageviews", "value")).toHaveText("3");
    await expect(kpi(page, "visitors", "value")).toHaveText("2");
    await expect(kpi(page, "views-per-visitor", "value")).toHaveText("1.5");
    for (const name of ["pageviews", "visitors", "views-per-visitor"]) {
      await expect(kpi(page, name, "delta")).toHaveText("—");
      await expect(kpi(page, name, "delta")).toHaveClass(/flat/);
    }

    await collect(request, site, b);
    await page.evaluate(() => window.__pulse.refresh());
    await expect(kpi(page, "pageviews", "value")).toHaveText("4");
  });

  test("deltas compare with the previous window", async ({ page, request }) => {
    const site = await newSite(request);
    await page.route(`**/api/pulse/sites/${site.id}/summary*`, (route) =>
      route.fulfill({
        json: summaryStub(site, { pageviews: 150, visitors: 30, previous: { pageviews: 100, visitors: 40 } }),
      }),
    );
    await page.goto(`/pulse?site=${site.id}`);
    await expect(kpi(page, "pageviews", "delta")).toHaveText("+50%");
    await expect(kpi(page, "pageviews", "delta")).toHaveClass(/up/);
    await expect(kpi(page, "visitors", "delta")).toHaveText("-25%");
    await expect(kpi(page, "visitors", "delta")).toHaveClass(/down/);
    await expect(kpi(page, "pageviews", "value")).toHaveText("150");
  });

  test("range switcher updates URL, request and survives a reload", async ({ page, request }) => {
    const site = await newSite(request);
    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator('#pulse-range [data-range="24h"]')).toHaveAttribute("aria-pressed", "true");
    const requested = page.waitForRequest((r) => r.url().includes("/summary?range=7d"));
    await page.getByRole("button", { name: "7 days" }).click();
    await requested;
    await expect(page.locator('#pulse-range [data-range="7d"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('#pulse-range [data-range="24h"]')).toHaveAttribute("aria-pressed", "false");
    await expect(page).toHaveURL(/range=7d/);

    await page.reload();
    await expect(page.locator('#pulse-range [data-range="7d"]')).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => window.__pulse.range)).toBe("7d");
  });

  test("an invalid range falls back to 24 hours", async ({ page, request }) => {
    const site = await newSite(request);
    await page.goto(`/pulse?site=${site.id}&range=bogus`);
    await expect(page.locator('#pulse-range [data-range="24h"]')).toHaveAttribute("aria-pressed", "true");
  });

  test("unknown site shows Site not found and mounts nothing", async ({ page }) => {
    await page.goto("/pulse?site=0000000000");
    await expect(page.locator("#pulse-status")).toHaveText("Site not found");
    await expect(page.locator("#pulse-kpis")).toHaveCount(0);
    await expect(page.locator("#pulse-grid")).toHaveCount(0);
  });

  test("a failing refresh shows an error and keeps the previous values", async ({ page, request }) => {
    const site = await newSite(request);
    await collect(request, site, visitor());
    await page.goto(`/pulse?site=${site.id}`);
    await expect(kpi(page, "pageviews", "value")).toHaveText("1");
    await page.route(`**/api/pulse/sites/${site.id}/summary*`, (route) =>
      route.fulfill({ status: 500, json: { error: "boom" } }),
    );
    await page.evaluate(() => window.__pulse.refresh());
    await expect(page.locator("#pulse-status")).toContainText("boom");
    await expect(kpi(page, "pageviews", "value")).toHaveText("1");
  });

  test("refresh calls are coalesced into one follow-up load", async ({ page, request }) => {
    const site = await newSite(request);
    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator("#pulse-app")).toHaveAttribute("aria-busy", "false");
    let calls = 0;
    await page.route(`**/api/pulse/sites/${site.id}/summary*`, async (route) => {
      calls++;
      await new Promise((r) => setTimeout(r, 200));
      await route.continue();
    });
    await page.evaluate(() => Promise.all([1, 2, 3, 4, 5].map(() => window.__pulse.refresh())));
    expect(calls).toBe(2);
  });

  test("ctx.onData fires after later loads only", async ({ page, request }) => {
    const site = await newSite(request);
    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator("#pulse-app")).toHaveAttribute("aria-busy", "false");
    const seen = await page.evaluate(async () => {
      const ranges = [];
      window.__pulse.ctx.onData(({ range }) => ranges.push(range));
      await window.__pulse.setRange("30d");
      return ranges;
    });
    expect(seen).toEqual(["30d"]);
  });
});

test.describe("pulse plugin cards", () => {
  test("addCard places cards by order and half cards sit side by side on desktop only", async ({ page, request }) => {
    const site = await newSite(request);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator("#pulse-app")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => {
      const { ctx } = window.__pulse;
      document.querySelectorAll("#pulse-grid > .pulse-card").forEach((card) => card.remove());
      ctx.addCard({ name: "c", title: "C", span: "half", order: 30 });
      ctx.addCard({ name: "a", title: "A", span: "half", order: 10 });
      ctx.addCard({ name: "b", title: "B", span: "full", order: 20 });
      ctx.addCard({ name: "d", title: "D", span: "half", order: 31 });
    });
    const order = await page.locator("#pulse-grid > .pulse-card").evaluateAll((els) => els.map((e) => e.dataset.plugin));
    expect(order.filter((name) => ["a", "b", "c", "d"].includes(name))).toEqual(["a", "b", "c", "d"]);
    await expect(page.locator('.pulse-card[data-plugin="a"] .pulse-card-title')).toHaveText("A");

    const box = (name) => page.locator(`.pulse-card[data-plugin="${name}"]`).boundingBox();
    const [c, d] = [await box("c"), await box("d")];
    expect(Math.abs(c.y - d.y)).toBeLessThan(2);
    expect(d.x).toBeGreaterThan(c.x + c.width - 1);

    await page.setViewportSize({ width: 375, height: 800 });
    const [c2, d2] = [await box("c"), await box("d")];
    expect(d2.y).toBeGreaterThan(c2.y + c2.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await expect(page.locator(".pulse-kpi").nth(1)).toBeVisible();
    const kpis = await page.locator(".pulse-kpi").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().y));
    expect(new Set(kpis).size).toBe(3);
  });

  test("KPI tiles sit in a row at 600px and wider", async ({ page, request }) => {
    const site = await newSite(request);
    await page.setViewportSize({ width: 700, height: 800 });
    await page.goto(`/pulse?site=${site.id}`);
    const ys = await page.locator(".pulse-kpi").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y)));
    expect(new Set(ys).size).toBe(1);
  });

  test("a throwing plugin does not stop the others from mounting", async ({ page, request }) => {
    const site = await newSite(request);
    await page.goto(`/pulse?site=${site.id}`);
    await expect(page.locator("#pulse-app")).toHaveAttribute("aria-busy", "false");
    const result = await page.evaluate(async () => {
      const { mountPlugins } = await import("/static/pulse/plugins/index.js");
      const log = [];
      const stop = mountPlugins(window.__pulse.ctx, [
        { mount() { throw new Error("nope"); } },
        { mount() { log.push("mounted"); return () => log.push("cleaned"); } },
      ]);
      stop();
      return log;
    });
    expect(result).toEqual(["mounted", "cleaned"]);
  });
});

test("dark mode changes the page background", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/pulse");
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await bg();
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await bg();
  expect(light).toBe("rgb(247, 247, 248)");
  expect(dark).toBe("rgb(15, 15, 19)");
});
