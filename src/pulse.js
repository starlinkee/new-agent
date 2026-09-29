import { randomBytes } from "node:crypto";
import { HttpError, readJson, send } from "./http.js";

export const SITE_BODY_MAX_BYTES = 4 * 1024;
export const COLLECT_BODY_MAX_BYTES = 2 * 1024;
export const SITE_LIST_LIMIT = 50;
export const MAX_NAME_LENGTH = 60;
export const MAX_PATH_LENGTH = 300;
export const MAX_REFERRER_LENGTH = 500;
export const MAX_WIDTH = 10000;
export const DEFAULT_BREAKDOWN_LIMIT = 10;
export const MAX_BREAKDOWN_LIMIT = 50;
export const RETENTION_MS = 31 * 24 * 3600 * 1000;

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RANGES = {
  "24h": { bucketMs: HOUR_MS, buckets: 24 },
  "7d": { bucketMs: DAY_MS, buckets: 7 },
  "30d": { bucketMs: DAY_MS, buckets: 30 },
};
const BREAKDOWN_KEYS = { page: "path", referrer: "referrer", device: "device" };

const DOMAIN = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const VISITOR = /^[A-Za-z0-9_-]{8,64}$/;

function badRequest(message) {
  return new HttpError(400, message);
}

function siteNotFound() {
  return new HttpError(404, "site not found");
}

export function validateSite(body) {
  const { name, domain } = body;
  if (typeof name !== "string" || name.trim() === "" || name.trim().length > MAX_NAME_LENGTH) {
    throw badRequest(`name must be a string of 1-${MAX_NAME_LENGTH} characters`);
  }
  let cleanDomain = null;
  if (domain !== undefined && domain !== null) {
    if (typeof domain !== "string") throw badRequest("domain must be a hostname");
    const lowered = domain.trim().toLowerCase();
    if (lowered !== "") {
      if (!DOMAIN.test(lowered)) throw badRequest("domain must be a bare hostname such as example.com");
      cleanDomain = lowered;
    }
  }
  return { name: name.trim(), domain: cleanDomain };
}

function deviceForWidth(width) {
  if (width === undefined || width === null) return "unknown";
  if (width < 768) return "mobile";
  if (width < 1024) return "tablet";
  return "desktop";
}

function referrerHost(referrer) {
  if (referrer === undefined || referrer === null) return null;
  if (typeof referrer !== "string") throw badRequest("referrer must be a string");
  if (referrer.length > MAX_REFERRER_LENGTH) throw badRequest(`referrer must be at most ${MAX_REFERRER_LENGTH} characters`);
  let host;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.startsWith("www.")) host = host.slice(4);
  return host === "" ? null : host;
}

// Validates a collect body against an existing site and returns the fields for PulseStore.record.
export function validateCollect(body, site) {
  const { path, visitor, width } = body;
  if (typeof path !== "string" || !path.startsWith("/") || path.length > MAX_PATH_LENGTH) {
    throw badRequest(`path must be a string starting with / of at most ${MAX_PATH_LENGTH} characters`);
  }
  if (typeof visitor !== "string" || !VISITOR.test(visitor)) {
    throw badRequest("visitor must be 8-64 characters of A-Z, a-z, 0-9, _ or -");
  }
  if (width !== undefined && (!Number.isInteger(width) || width < 0 || width > MAX_WIDTH)) {
    throw badRequest(`width must be an integer between 0 and ${MAX_WIDTH}`);
  }
  let referrer = referrerHost(body.referrer);
  if (referrer !== null && referrer === site.domain) referrer = null;
  return {
    path: path.replace(/[?#].*$/s, ""),
    referrer,
    device: deviceForWidth(width),
    visitor,
  };
}

// In-memory analytics store: sites and their hits, kept in insertion (time) order.
export class PulseStore {
  #sites = new Map();
  #hits = new Map();
  #now;
  #maxSites;
  #maxHitsPerSite;
  #listeners = new Set();

  constructor({ now = Date.now, maxSites = 200, maxHitsPerSite = 50000 } = {}) {
    this.#now = now;
    this.#maxSites = maxSites;
    this.#maxHitsPerSite = maxHitsPerSite;
  }

  #emit(event) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error("pulse listener failed:", err);
      }
    }
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #newId() {
    let id;
    do id = randomBytes(5).toString("hex");
    while (this.#sites.has(id));
    return id;
  }

  createSite({ name, domain = null }) {
    const site = { id: this.#newId(), name, domain, createdAt: new Date(this.#now()).toISOString() };
    this.#sites.set(site.id, site);
    this.#hits.set(site.id, []);
    while (this.#sites.size > this.#maxSites) {
      const oldest = this.#sites.keys().next().value;
      this.#sites.delete(oldest);
      this.#hits.delete(oldest);
    }
    this.#emit({ type: "site", site: { ...site } });
    return { ...site };
  }

  // Newest first, at most `limit`.
  listSites(limit = SITE_LIST_LIMIT) {
    return [...this.#sites.values()].reverse().slice(0, limit).map((site) => ({ ...site }));
  }

  getSite(id) {
    const site = this.#sites.get(id);
    return site ? { ...site } : undefined;
  }

  #hitsOf(siteId) {
    const hits = this.#hits.get(siteId);
    if (!hits) throw siteNotFound();
    return hits;
  }

  // Stamps the hit with now(), stores it and emits `hit`. Throws HttpError 404 for an unknown site.
  record(siteId, { path, referrer = null, device = "unknown", visitor }) {
    const hits = this.#hitsOf(siteId);
    const now = this.#now();
    const hit = { path, referrer, device, visitor, at: new Date(now).toISOString() };
    hits.push({ hit, ms: now });
    const cutoff = now - RETENTION_MS;
    let drop = Math.max(0, hits.length - this.#maxHitsPerSite);
    while (drop < hits.length && hits[drop].ms < cutoff) drop += 1;
    if (drop > 0) hits.splice(0, drop);
    this.#emit({ type: "hit", siteId, hit: { ...hit } });
    return { ...hit };
  }

  // Window of the range: `from` is the start of the first bucket, `to` is now.
  #window(range) {
    const spec = Object.hasOwn(RANGES, range) ? RANGES[range] : undefined;
    if (!spec) throw badRequest("range must be one of 24h, 7d, 30d");
    const to = this.#now();
    const lastStart = Math.floor(to / spec.bucketMs) * spec.bucketMs;
    return { ...spec, from: lastStart - (spec.buckets - 1) * spec.bucketMs, to };
  }

  #inWindow(siteId, from, to) {
    return this.#hitsOf(siteId).filter((entry) => entry.ms >= from && entry.ms <= to);
  }

  summary(siteId, range = "24h") {
    const site = this.getSite(siteId);
    if (!site) throw siteNotFound();
    const { bucketMs, buckets, from, to } = this.#window(range);
    const views = Array.from({ length: buckets }, () => ({ pageviews: 0, visitors: new Set() }));
    const visitors = new Set();
    let pageviews = 0;
    for (const { hit, ms } of this.#inWindow(siteId, from, to)) {
      const bucket = views[Math.floor((ms - from) / bucketMs)];
      bucket.pageviews += 1;
      bucket.visitors.add(hit.visitor);
      pageviews += 1;
      visitors.add(hit.visitor);
    }
    const before = this.#inWindow(siteId, from - (to - from), from - 1);
    return {
      site,
      range,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      pageviews,
      visitors: visitors.size,
      previous: { pageviews: before.length, visitors: new Set(before.map((entry) => entry.hit.visitor)).size },
      series: views.map((bucket, i) => ({
        t: new Date(from + i * bucketMs).toISOString(),
        pageviews: bucket.pageviews,
        visitors: bucket.visitors.size,
      })),
    };
  }

  // Rows sorted by pageviews desc, then key asc (null last). `by` is page, referrer or device.
  breakdown(siteId, by, range = "24h", limit = DEFAULT_BREAKDOWN_LIMIT) {
    const field = Object.hasOwn(BREAKDOWN_KEYS, by) ? BREAKDOWN_KEYS[by] : undefined;
    if (!field) throw badRequest("by must be one of page, referrer, device");
    const { from, to } = this.#window(range);
    const groups = new Map();
    for (const { hit } of this.#inWindow(siteId, from, to)) {
      const key = hit[field];
      if (!groups.has(key)) groups.set(key, { key, pageviews: 0, visitors: new Set() });
      const group = groups.get(key);
      group.pageviews += 1;
      group.visitors.add(hit.visitor);
    }
    const rows = [...groups.values()]
      .sort((a, b) => {
        if (b.pageviews !== a.pageviews) return b.pageviews - a.pageviews;
        if (a.key === b.key) return 0;
        if (a.key === null) return 1;
        if (b.key === null) return -1;
        return a.key < b.key ? -1 : 1;
      })
      .slice(0, limit)
      .map((group) => ({ key: group.key, pageviews: group.pageviews, visitors: group.visitors.size }));
    return { by, range, rows };
  }

  // Number of distinct visitors with a hit in the last `windowMs`.
  activeVisitors(siteId, windowMs = 300000) {
    const now = this.#now();
    const visitors = new Set();
    for (const { hit, ms } of this.#hitsOf(siteId)) {
      if (ms > now - windowMs && ms <= now) visitors.add(hit.visitor);
    }
    return visitors.size;
  }

  // Newest first, at most `limit`.
  recentHits(siteId, limit = 20) {
    return this.#hitsOf(siteId)
      .slice(-limit)
      .reverse()
      .map((entry) => ({ ...entry.hit }));
  }
}

export const pulseStore = new PulseStore();

function methodNotAllowed(allow) {
  return new HttpError(405, "method not allowed", { allow });
}

// The tracker sends text/plain (no CORS preflight); it holds the same JSON object, so it is read
// with readJson's limits and error codes.
function readCollectBody(req) {
  const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type === "text/plain") req.headers["content-type"] = "application/json";
  else if (type !== "application/json") {
    return Promise.reject(new HttpError(415, "content-type must be application/json or text/plain"));
  }
  return readJson(req, { maxBytes: COLLECT_BODY_MAX_BYTES });
}

const COLLECT_CORS = { "access-control-allow-origin": "*" };

async function collect(store, req, res) {
  if (req.method === "OPTIONS") {
    return send(res, 204, undefined, {
      ...COLLECT_CORS,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
    });
  }
  if (req.method !== "POST") throw methodNotAllowed("POST, OPTIONS");
  const body = await readCollectBody(req);
  const site = typeof body.site === "string" ? store.getSite(body.site) : undefined;
  if (!site) throw siteNotFound();
  store.record(site.id, validateCollect(body, site));
  return send(res, 202, undefined, COLLECT_CORS);
}

function query(url, name, fallback) {
  return url.searchParams.has(name) ? url.searchParams.get(name) : fallback;
}

function parseLimit(raw) {
  const limit = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(limit >= 1 && limit <= MAX_BREAKDOWN_LIMIT)) {
    throw badRequest(`limit must be an integer between 1 and ${MAX_BREAKDOWN_LIMIT}`);
  }
  return limit;
}

async function route(store, req, res, url, match) {
  const [, id, action] = match;
  if (id === undefined) {
    if (req.method === "GET") return send(res, 200, { sites: store.listSites() });
    if (req.method === "POST") {
      const input = validateSite(await readJson(req, { maxBytes: SITE_BODY_MAX_BYTES }));
      return send(res, 201, store.createSite(input));
    }
    throw methodNotAllowed("GET, POST");
  }
  if (req.method !== "GET") throw methodNotAllowed("GET");
  const site = store.getSite(id);
  if (!site) throw siteNotFound();
  if (action === undefined) return send(res, 200, site);
  const range = query(url, "range", "24h");
  if (action === "summary") return send(res, 200, store.summary(id, range));
  return send(res, 200, store.breakdown(id, query(url, "by", null), range, parseLimit(query(url, "limit", String(DEFAULT_BREAKDOWN_LIMIT)))));
}

// Returns a handler for /api/pulse/sites, /api/pulse/sites/<id>, its summary and breakdown, and
// /api/pulse/collect: resolves true when handled.
export function createPulseHandler(store = pulseStore) {
  return async function handlePulse(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return false;
    }
    const isCollect = /^\/api\/pulse\/collect\/?$/.test(url.pathname);
    const match = /^\/api\/pulse\/sites(?:\/([^/]+)(?:\/(summary|breakdown))?)?\/?$/.exec(url.pathname);
    if (!isCollect && !match) return false;
    try {
      if (isCollect) await collect(store, req, res);
      else await route(store, req, res, url, match);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (res.headersSent) return true;
      send(res, err.status, { error: err.message }, { ...(isCollect ? COLLECT_CORS : {}), ...err.headers });
      if (err.status === 413) res.once("finish", () => req.destroy());
    }
    return true;
  };
}

export const handlePulse = createPulseHandler();
