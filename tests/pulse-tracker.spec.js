import { test, expect } from "@playwright/test";

const suffix = () => Math.random().toString(36).slice(2, 10);

async function newSite(request) {
  const res = await request.post("/api/pulse/sites", { data: { name: `Tracker ${suffix()}` } });
  expect(res.status()).toBe(201);
  return res.json();
}

const summary = async (request, site) => (await request.get(`/api/pulse/sites/${site.id}/summary?range=24h`)).json();
const referrers = async (request, site) => (await request.get(`/api/pulse/sites/${site.id}/breakdown?by=referrer&range=24h`)).json();
const pages = async (request, site) => (await request.get(`/api/pulse/sites/${site.id}/breakdown?by=page&range=24h`)).json();

// The fake client page is served by page.route on the app origin. Cross-origin is not testable in headless
// Chromium: its local-network-access check blocks every localhost -> 127.0.0.1 request ("Permission was denied
// for this request to access the `loopback` address space"), for the script and for the beacon alike.
async function clientPage(page, baseURL, attrs, path = "/__client/home") {
  const origin = new URL(baseURL).origin;
  const html = `<!doctype html><html><head><title>Client</title><script defer src="${origin}/static/pulse/tracker.js" ${attrs}></script></head><body>client</body></html>`;
  await page.route(`${origin}/__client/**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  return `${origin}${path}`;
}

test.describe("pulse tracker", () => {
  test("records a pageview with the referrer host and keeps the visitor across reloads", async ({ page, request, baseURL }) => {
    const site = await newSite(request);
    const url = await clientPage(page, baseURL, `data-site="${site.id}"`);
    await page.goto(url, { referer: "https://www.Example.org/some/page" });
    await expect.poll(async () => (await summary(request, site)).pageviews).toBe(1);
    expect((await pages(request, site)).rows).toEqual([{ key: "/__client/home", pageviews: 1, visitors: 1 }]);
    expect((await referrers(request, site)).rows).toEqual([{ key: "example.org", pageviews: 1, visitors: 1 }]);

    await page.reload();
    await expect.poll(async () => (await summary(request, site)).pageviews).toBe(2);
    expect((await summary(request, site)).visitors).toBe(1);
  });

  test("tracks SPA navigation but ignores hash, query and same-path changes", async ({ page, request, baseURL }) => {
    const site = await newSite(request);
    await page.goto(await clientPage(page, baseURL, `data-site="${site.id}"`));
    await expect.poll(async () => (await summary(request, site)).pageviews).toBe(1);

    await page.evaluate(() => {
      history.pushState(null, "", "/__client/home#section");
      history.pushState(null, "", "/__client/home?x=1");
      history.pushState(null, "", "/__client/home");
      history.replaceState(null, "", "/__client/home");
    });
    await page.evaluate(() => history.pushState(null, "", "/__client/other"));
    await expect.poll(async () => (await summary(request, site)).pageviews).toBe(2);
    await page.waitForTimeout(500);
    const { rows } = await pages(request, site);
    expect(rows.map((r) => r.key).sort()).toEqual(["/__client/home", "/__client/other"]);
    expect((await summary(request, site)).pageviews).toBe(2);
    expect((await referrers(request, site)).rows.length).toBeLessThanOrEqual(1);
  });

  test("does nothing with Do Not Track or without data-site", async ({ page, request, baseURL }) => {
    const site = await newSite(request);
    const collects = [];
    page.on("request", (req) => req.url().includes("/api/pulse/collect") && collects.push(req.url()));

    await page.addInitScript(() => Object.defineProperty(navigator, "doNotTrack", { get: () => "1" }));
    await page.goto(await clientPage(page, baseURL, `data-site="${site.id}"`));
    await page.evaluate(() => window.pulse.pageview());

    const other = await page.context().newPage();
    other.on("request", (req) => req.url().includes("/api/pulse/collect") && collects.push(req.url()));
    await other.goto(await clientPage(other, baseURL, ""));

    await page.waitForTimeout(500);
    expect(collects).toEqual([]);
    expect((await summary(request, site)).pageviews).toBe(0);
  });

  test("falls back to fetch when sendBeacon is missing", async ({ page, request, baseURL }) => {
    const site = await newSite(request);
    await page.addInitScript(() => Object.defineProperty(navigator, "sendBeacon", { value: undefined }));
    await page.goto(await clientPage(page, baseURL, `data-site="${site.id}"`));
    await expect.poll(async () => (await summary(request, site)).pageviews).toBe(1);
  });
});

test.describe("pulse install card", () => {
  test("shows the snippet, copies it and reflects incoming data", async ({ page, request, context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const site = await newSite(request);
    await page.goto(`/pulse?site=${site.id}`);

    const snippet = `<script defer src="${new URL(baseURL).origin}/static/pulse/tracker.js" data-site="${site.id}"></script>`;
    await expect(page.locator("#pulse-install-snippet")).toHaveText(snippet);
    await expect(page.locator('[data-plugin="install"]')).toContainText("Add this snippet to the <head> of every page on your site.");
    const status = page.locator("#pulse-install-status");
    await expect(status).toHaveText("Waiting for the first pageview…");

    await page.click("#pulse-install-copy");
    await expect(status).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(snippet);
    await expect(status).toHaveText("Waiting for the first pageview…", { timeout: 5000 });

    const res = await request.post("/api/pulse/collect", { data: { site: site.id, path: "/", visitor: `v${suffix()}${suffix()}` } });
    expect(res.status()).toBe(202);
    await page.evaluate(() => window.__pulse.refresh());
    await expect(status).toHaveText("Receiving data");
  });

  test("selects the snippet when the clipboard is unavailable", async ({ page, request }) => {
    const site = await newSite(request);
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) } }));
    await page.goto(`/pulse?site=${site.id}`);
    await page.click("#pulse-install-copy");
    await expect(page.locator("#pulse-install-status")).toHaveText("Press Ctrl+C to copy");
    expect(await page.evaluate(() => getSelection().toString())).toContain("tracker.js");
  });
});
