import { test, expect, request as pwRequest } from "@playwright/test";
import { createPulseHandler, PulseStore } from "../src/pulse.js";
import http from "node:http";

const suffix = () => Math.random().toString(36).slice(2, 10);
const visitor = () => `v${suffix()}${suffix()}`;

async function newSite(request, over = {}) {
  const res = await request.post("/api/pulse/sites", { data: { name: `Site ${suffix()}`, ...over } });
  expect(res.status()).toBe(201);
  return res.json();
}

const hit = (request, site, over = {}) =>
  request.post("/api/pulse/collect", { data: { site: site.id, path: "/", visitor: visitor(), ...over } });

test.describe("pulse sites API", () => {
  test("create returns 201 with the right shape, is listed and fetchable", async ({ request }) => {
    const name = `Padded ${suffix()}`;
    const res = await request.post("/api/pulse/sites", { data: { name: `  ${name}  `, domain: " Example.COM " } });
    expect(res.status()).toBe(201);
    const site = await res.json();
    expect(site.id).toMatch(/^[0-9a-f]{10}$/);
    expect(site.name).toBe(name);
    expect(site.domain).toBe("example.com");
    expect(new Date(site.createdAt).toISOString()).toBe(site.createdAt);

    const list = await (await request.get("/api/pulse/sites")).json();
    expect(list.sites.length).toBeLessThanOrEqual(50);
    expect(list.sites.find((s) => s.id === site.id)).toEqual(site);
    const got = await request.get(`/api/pulse/sites/${site.id}`);
    expect(got.status()).toBe(200);
    expect(await got.json()).toEqual(site);
  });

  test("domain is null when missing or empty", async ({ request }) => {
    expect((await newSite(request)).domain).toBeNull();
    expect((await newSite(request, { domain: "  " })).domain).toBeNull();
  });

  test("invalid name or domain -> 400", async ({ request }) => {
    for (const data of [
      { name: "   " },
      { name: "x".repeat(61) },
      { name: 5 },
      {},
      { name: "ok", domain: "https://x.com/a" },
      { name: "ok", domain: "x.com:8080" },
      { name: "ok", domain: "a b.com" },
      { name: "ok", domain: 7 },
    ]) {
      const res = await request.post("/api/pulse/sites", { data });
      expect(res.status(), JSON.stringify(data)).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    }
    expect((await newSite(request, { name: "x".repeat(60) })).name).toHaveLength(60);
  });

  test("415, 413, malformed 400", async ({ request }) => {
    const wrongType = await request.post("/api/pulse/sites", { headers: { "content-type": "text/plain" }, data: "{}" });
    expect(wrongType.status()).toBe(415);
    const big = await request.post("/api/pulse/sites", { data: { name: "x", pad: "y".repeat(5000) } });
    expect(big.status()).toBe(413);
    const bad = await request.post("/api/pulse/sites", { headers: { "content-type": "application/json" }, data: "{nope" });
    expect(bad.status()).toBe(400);
  });

  test("unknown site 404 on every per-site route, wrong method 405 with Allow", async ({ request }) => {
    for (const path of ["", "/summary", "/breakdown?by=page"]) {
      const res = await request.get(`/api/pulse/sites/0000000000${path}`);
      expect(res.status(), path).toBe(404);
      expect(await res.json()).toEqual({ error: "site not found" });
    }
    const site = await newSite(request);
    const put = await request.put("/api/pulse/sites");
    expect(put.status()).toBe(405);
    expect(put.headers().allow).toBe("GET, POST");
    const post = await request.post(`/api/pulse/sites/${site.id}`, { data: {} });
    expect(post.status()).toBe(405);
    expect(post.headers().allow).toBe("GET");
    const collectGet = await request.get("/api/pulse/collect");
    expect(collectGet.status()).toBe(405);
    expect(collectGet.headers().allow).toBe("POST, OPTIONS");
  });

  test("other /api/pulse/sites/<id>/<name> paths are left to the server 404", async ({ request }) => {
    const site = await newSite(request);
    const res = await request.get(`/api/pulse/sites/${site.id}/nope`);
    expect(res.status()).toBe(404);
    expect(res.headers()["content-type"]).not.toContain("application/json");
  });
});

test.describe("pulse collect", () => {
  test("202 with CORS header, also with text/plain", async ({ request }) => {
    const site = await newSite(request);
    const json = await hit(request, site);
    expect(json.status()).toBe(202);
    expect(json.headers()["access-control-allow-origin"]).toBe("*");
    expect(await json.text()).toBe("");
    const plain = await request.post("/api/pulse/collect", {
      headers: { "content-type": "text/plain;charset=UTF-8" },
      data: JSON.stringify({ site: site.id, path: "/beacon", visitor: visitor() }),
    });
    expect(plain.status()).toBe(202);
    expect(plain.headers()["access-control-allow-origin"]).toBe("*");
    const rows = (await (await request.get(`/api/pulse/sites/${site.id}/breakdown?by=page`)).json()).rows;
    expect(rows.map((r) => r.key).sort()).toEqual(["/", "/beacon"]);
  });

  test("OPTIONS returns the preflight headers", async ({ request }) => {
    const res = await request.fetch("/api/pulse/collect", { method: "OPTIONS" });
    expect(res.status()).toBe(204);
    const headers = res.headers();
    expect(headers["access-control-allow-origin"]).toBe("*");
    expect(headers["access-control-allow-methods"]).toBe("POST, OPTIONS");
    expect(headers["access-control-allow-headers"]).toBe("content-type");
    expect(headers["access-control-max-age"]).toBe("86400");
  });

  test("415, 413, malformed 400 and unknown site 404 all carry the CORS header", async ({ request }) => {
    const html = await request.post("/api/pulse/collect", { headers: { "content-type": "text/html" }, data: "<p>" });
    expect(html.status()).toBe(415);
    const big = await request.post("/api/pulse/collect", {
      headers: { "content-type": "text/plain" },
      data: JSON.stringify({ site: "x", pad: "y".repeat(3000) }),
    });
    expect(big.status()).toBe(413);
    const bad = await request.post("/api/pulse/collect", { headers: { "content-type": "text/plain" }, data: "{nope" });
    expect(bad.status()).toBe(400);
    const missing = await request.post("/api/pulse/collect", {
      data: { site: "0000000000", path: "/", visitor: visitor() },
    });
    expect(missing.status()).toBe(404);
    for (const res of [html, big, bad, missing]) expect(res.headers()["access-control-allow-origin"]).toBe("*");
  });

  test("bad path, visitor or width -> 400", async ({ request }) => {
    const site = await newSite(request);
    for (const over of [
      { path: "no-slash" },
      { path: 5 },
      { path: `/${"a".repeat(300)}` },
      { path: undefined },
      { visitor: "short" },
      { visitor: "has space in it" },
      { visitor: "a".repeat(65) },
      { visitor: undefined },
      { width: -1 },
      { width: 10001 },
      { width: 1.5 },
      { width: "800" },
    ]) {
      const res = await hit(request, site, over);
      expect(res.status(), JSON.stringify(over)).toBe(400);
      expect(res.headers()["access-control-allow-origin"]).toBe("*");
    }
  });

  test("the query and hash are stripped from path", async ({ request }) => {
    const site = await newSite(request);
    await hit(request, site, { path: "/pricing?utm=1#top" });
    await hit(request, site, { path: "/pricing#x" });
    const { rows } = await (await request.get(`/api/pulse/sites/${site.id}/breakdown?by=page`)).json();
    expect(rows).toEqual([{ key: "/pricing", pageviews: 2, visitors: expect.any(Number) }]);
  });

  test("referrer host is normalised, self-referrals and junk are direct", async ({ request }) => {
    const site = await newSite(request, { domain: "mine.example" });
    await hit(request, site, { referrer: "https://www.Google.com/search?q=1" });
    await hit(request, site, { referrer: "https://mine.example/page" });
    await hit(request, site, { referrer: "https://www.mine.example/page" });
    await hit(request, site, { referrer: "not a url" });
    await hit(request, site, { referrer: "" });
    await hit(request, site);
    const { rows } = await (await request.get(`/api/pulse/sites/${site.id}/breakdown?by=referrer`)).json();
    expect(rows.map((r) => [r.key, r.pageviews])).toEqual([[null, 5], ["google.com", 1]]);
  });

  test("width maps to a device", async ({ request }) => {
    const site = await newSite(request);
    for (const width of [767, 768, 1024, undefined]) await hit(request, site, { width });
    const { rows } = await (await request.get(`/api/pulse/sites/${site.id}/breakdown?by=device`)).json();
    expect(rows.map((r) => r.key)).toEqual(["desktop", "mobile", "tablet", "unknown"]);
    expect(rows.every((r) => r.pageviews === 1)).toBe(true);
  });
});

test.describe("pulse summary and breakdown", () => {
  test("3 hits from 2 visitors", async ({ request }) => {
    const site = await newSite(request);
    const [a, b] = [visitor(), visitor()];
    for (const v of [a, a, b]) await hit(request, site, { visitor: v });
    const res = await request.get(`/api/pulse/sites/${site.id}/summary`);
    expect(res.status()).toBe(200);
    const summary = await res.json();
    expect(summary.site).toEqual(site);
    expect(summary.range).toBe("24h");
    expect(summary.pageviews).toBe(3);
    expect(summary.visitors).toBe(2);
    expect(summary.previous).toEqual({ pageviews: 0, visitors: 0 });
    expect(summary.series).toHaveLength(24);
    expect(summary.series.at(-1)).toMatchObject({ pageviews: 3, visitors: 2 });
    expect(Date.parse(summary.to)).toBeGreaterThanOrEqual(Date.parse(summary.from));
  });

  test("series lengths per range and bad range -> 400", async ({ request }) => {
    const site = await newSite(request);
    for (const [range, length] of [["24h", 24], ["7d", 7], ["30d", 30]]) {
      const summary = await (await request.get(`/api/pulse/sites/${site.id}/summary?range=${range}`)).json();
      expect(summary.series).toHaveLength(length);
      expect(summary.series[0].t).toBe(summary.from);
    }
    for (const range of ["1h", "", "constructor"]) {
      expect((await request.get(`/api/pulse/sites/${site.id}/summary?range=${range}`)).status()).toBe(400);
      expect((await request.get(`/api/pulse/sites/${site.id}/breakdown?by=page&range=${range}`)).status()).toBe(400);
    }
  });

  test("breakdown by page orders by pageviews, then key, and respects limit", async ({ request }) => {
    const site = await newSite(request);
    for (const path of ["/b", "/a", "/c", "/c", "/c", "/b"]) await hit(request, site, { path });
    const page = await (await request.get(`/api/pulse/sites/${site.id}/breakdown?by=page&range=7d`)).json();
    expect(page.by).toBe("page");
    expect(page.range).toBe("7d");
    expect(page.rows.map((r) => [r.key, r.pageviews])).toEqual([["/c", 3], ["/b", 2], ["/a", 1]]);
    const limited = await (await request.get(`/api/pulse/sites/${site.id}/breakdown?by=page&limit=2`)).json();
    expect(limited.rows.map((r) => r.key)).toEqual(["/c", "/b"]);
  });

  test("breakdown by referrer puts direct traffic last on ties", async ({ request }) => {
    const site = await newSite(request);
    await hit(request, site);
    await hit(request, site, { referrer: "https://zeta.example/" });
    await hit(request, site, { referrer: "https://alpha.example/" });
    const { rows } = await (await request.get(`/api/pulse/sites/${site.id}/breakdown?by=referrer`)).json();
    expect(rows.map((r) => r.key)).toEqual(["alpha.example", "zeta.example", null]);
  });

  test("bad by or limit -> 400", async ({ request }) => {
    const site = await newSite(request);
    const base = `/api/pulse/sites/${site.id}/breakdown`;
    for (const q of ["", "?by=nope", "?by=constructor", "?by=page&limit=0", "?by=page&limit=51", "?by=page&limit=x", "?by=page&limit=1.5", "?by=page&limit="]) {
      expect((await request.get(base + q)).status(), q).toBe(400);
    }
    expect((await request.get(`${base}?by=page&limit=50`)).status()).toBe(200);
  });
});

test.describe("PulseStore with an injected clock", () => {
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const base = Date.UTC(2024, 0, 15, 10, 30, 0);
  let clock;
  let store;
  let siteId;
  test.beforeEach(() => {
    clock = base;
    store = new PulseStore({ now: () => clock });
    siteId = store.createSite({ name: "clock" }).id;
  });
  const add = (over = {}) => store.record(siteId, { path: "/", referrer: null, device: "desktop", visitor: `visitor-${suffix()}`, ...over });

  test("bucket starts are aligned to UTC hours and days, oldest first", () => {
    add();
    const day = store.summary(siteId, "24h");
    expect(day.from).toBe(new Date(Date.UTC(2024, 0, 14, 11)).toISOString());
    expect(day.to).toBe(new Date(base).toISOString());
    expect(day.series[0].t).toBe(day.from);
    expect(day.series[23].t).toBe(new Date(Date.UTC(2024, 0, 15, 10)).toISOString());
    expect(day.series[23].pageviews).toBe(1);
    const week = store.summary(siteId, "7d");
    expect(week.series.map((b) => b.t)).toEqual(
      Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2024, 0, 9 + i)).toISOString()),
    );
    expect(store.summary(siteId, "30d").series[0].t).toBe(new Date(Date.UTC(2023, 11, 17)).toISOString());
  });

  test("a hit 25 h ago is in previous, not in the current window", () => {
    clock = base - 25 * HOUR;
    add();
    clock = base;
    add();
    const summary = store.summary(siteId, "24h");
    expect(summary.pageviews).toBe(1);
    expect(summary.previous).toEqual({ pageviews: 1, visitors: 1 });
  });

  test("hits land in the right bucket and the window edges are inclusive of now", () => {
    clock = base - 2 * HOUR;
    add({ visitor: "same-visitor" });
    add({ visitor: "same-visitor" });
    clock = base;
    add();
    const { series } = store.summary(siteId, "24h");
    expect(series[21]).toMatchObject({ pageviews: 2, visitors: 1 });
    expect(series[23]).toMatchObject({ pageviews: 1, visitors: 1 });
  });

  test("hits older than 31 days are dropped when new hits arrive", () => {
    clock = base - 32 * DAY;
    add({ path: "/old" });
    clock = base - 30 * DAY;
    add({ path: "/edge" });
    clock = base;
    add({ path: "/new" });
    expect(store.recentHits(siteId, 10).map((h) => h.path)).toEqual(["/new", "/edge"]);
  });

  test("maxHitsPerSite drops the oldest hits and maxSites the oldest sites", () => {
    const small = new PulseStore({ now: () => clock, maxHitsPerSite: 2, maxSites: 2 });
    const first = small.createSite({ name: "one" }).id;
    for (const path of ["/1", "/2", "/3"]) small.record(first, { path, visitor: "visitor-1" });
    expect(small.recentHits(first).map((h) => h.path)).toEqual(["/3", "/2"]);
    const second = small.createSite({ name: "two" }).id;
    const third = small.createSite({ name: "three" }).id;
    expect(small.getSite(first)).toBeUndefined();
    expect(small.listSites().map((s) => s.id)).toEqual([third, second]);
    expect(() => small.recentHits(first)).toThrow(/site not found/);
  });

  test("activeVisitors counts distinct visitors inside the window; recentHits is newest first", () => {
    clock = base - 10 * 60 * 1000;
    add({ visitor: "visitor-old", path: "/old" });
    clock = base - 60 * 1000;
    add({ visitor: "visitor-a", path: "/a" });
    add({ visitor: "visitor-a", path: "/a2" });
    clock = base;
    add({ visitor: "visitor-b", path: "/b" });
    expect(store.activeVisitors(siteId)).toBe(2);
    expect(store.activeVisitors(siteId, 30 * 1000)).toBe(1);
    expect(store.activeVisitors(siteId, 20 * 60 * 1000)).toBe(3);
    expect(store.recentHits(siteId, 3).map((h) => h.path)).toEqual(["/b", "/a2", "/a"]);
    expect(store.recentHits(siteId)).toHaveLength(4);
  });

  test("subscribe receives site and hit events; a throwing listener is harmless; unsubscribe stops delivery", () => {
    const events = [];
    const unsubscribe = store.subscribe((event) => events.push(event));
    store.subscribe(() => {
      throw new Error("boom");
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const site = store.createSite({ name: "evented", domain: "e.example" });
      const recorded = store.record(site.id, { path: "/x", referrer: "a.example", device: "mobile", visitor: "visitor-x" });
      expect(events).toEqual([
        { type: "site", site },
        { type: "hit", siteId: site.id, hit: recorded },
      ]);
      expect(recorded).toEqual({ path: "/x", referrer: "a.example", device: "mobile", visitor: "visitor-x", at: new Date(base).toISOString() });
      unsubscribe();
      add();
      expect(events).toHaveLength(2);
    } finally {
      console.error = originalError;
    }
  });
});

test.describe("createPulseHandler on a dedicated store", () => {
  let server;
  let api;
  test.beforeAll(async () => {
    const handler = createPulseHandler(new PulseStore());
    server = http.createServer(async (req, res) => {
      if (!(await handler(req, res))) res.writeHead(418).end();
    });
    await new Promise((r) => server.listen(0, r));
    api = await pwRequest.newContext({ baseURL: `http://localhost:${server.address().port}` });
  });
  test.afterAll(async () => {
    await api.dispose();
    await new Promise((r) => server.close(r));
  });

  test("routes it does not own return false", async () => {
    const site = await (await api.post("/api/pulse/sites", { data: { name: "own" } })).json();
    for (const path of [`/api/pulse/sites/${site.id}/nope`, `/api/pulse/sites/${site.id}/live`, "/api/pulse", "/api/pulse/other", "/pulse"]) {
      expect((await api.get(path)).status(), path).toBe(418);
    }
    expect((await api.get(`/api/pulse/sites/${site.id}`)).status()).toBe(200);
  });
});
