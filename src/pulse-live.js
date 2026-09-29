import { send } from "./http.js";
import { pulseStore } from "./pulse.js";

export const PING_INTERVAL_MS = 25_000;
export const ACTIVE_WINDOW_MS = 300_000;
export const SNAPSHOT_HITS = 10;

const LIVE_ROUTE = /^\/api\/pulse\/sites\/([^/]+)\/live$/;

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// Returns a handler for GET /api/pulse/sites/<id>/live (SSE): resolves true when the request was handled.
export function createPulseLiveHandler(store = pulseStore, { pingMs = PING_INTERVAL_MS, activeWindowMs = ACTIVE_WINDOW_MS } = {}) {
  return async function handlePulseLive(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return false;
    }
    const match = LIVE_ROUTE.exec(pathname);
    if (!match) return false;
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed" }, { allow: "GET" });
      return true;
    }
    const siteId = match[1];
    if (!store.getSite(siteId)) {
      send(res, 404, { error: "site not found" });
      return true;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.write("retry: 2000\n: connected\n\n");
    res.write(frame("snapshot", { active: store.activeVisitors(siteId, activeWindowMs), recent: store.recentHits(siteId, SNAPSHOT_HITS) }));
    const unsubscribe = store.subscribe((event) => {
      if (event.type !== "hit" || event.siteId !== siteId) return;
      res.write(frame("hit", { hit: event.hit, active: store.activeVisitors(siteId, activeWindowMs) }));
    });
    const timer = setInterval(() => res.write(": ping\n\n"), pingMs);
    res.on("close", () => {
      clearInterval(timer);
      unsubscribe();
    });
    return true;
  };
}

export const handlePulseLive = createPulseLiveHandler();
