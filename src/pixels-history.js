import { HttpError, send } from "./http.js";
import { pixelStore } from "./pixels.js";

export const HISTORY_SIZE = 10000;

// Ring buffer of the most recent paints, oldest first when read.
export class PixelHistory {
  #events = new Array(HISTORY_SIZE);
  #start = 0;
  #length = 0;
  // updatedAt of the newest paint that fell out of the buffer, or null while nothing has.
  #lastEvicted = null;

  record(event) {
    if (this.#length === HISTORY_SIZE) {
      this.#lastEvicted = this.#events[this.#start].updatedAt;
      this.#events[this.#start] = event;
      this.#start = (this.#start + 1) % HISTORY_SIZE;
    } else {
      this.#events[(this.#start + this.#length) % HISTORY_SIZE] = event;
      this.#length++;
    }
  }

  // Events painted strictly after `since` (an ISO string, or null for all), oldest first, at most `limit`.
  // truncated: some matching paints are not in the result (cut by limit, or evicted from the buffer).
  read({ since = null, limit = HISTORY_SIZE } = {}) {
    const matching = [];
    for (let i = 0; i < this.#length; i++) {
      const event = this.#events[(this.#start + i) % HISTORY_SIZE];
      if (since === null || event.updatedAt > since) matching.push(event);
    }
    const evicted = this.#lastEvicted !== null && (since === null || this.#lastEvicted > since);
    return {
      events: matching.slice(0, limit).map((e) => ({ ...e })),
      truncated: matching.length > limit || evicted,
    };
  }
}

function parseSince(value) {
  if (value === null) return null;
  const time = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(time.getTime())) {
    throw new HttpError(400, "since must be an ISO 8601 timestamp");
  }
  return time.toISOString();
}

function parseLimit(value) {
  if (value === null) return HISTORY_SIZE;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > HISTORY_SIZE) {
    throw new HttpError(400, `limit must be an integer between 1 and ${HISTORY_SIZE}`);
  }
  return Number(value);
}

// Returns a handler for GET /api/pixels/history: resolves true when the request was handled.
export function createHistoryHandler(store = pixelStore, history = new PixelHistory()) {
  store.subscribe((change) => history.record(change));
  return async function handlePixelsHistory(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return false;
    }
    if (url.pathname !== "/api/pixels/history") return false;
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        throw new HttpError(405, "method not allowed", { allow: "GET, HEAD" });
      }
      const since = parseSince(url.searchParams.get("since"));
      const limit = parseLimit(url.searchParams.get("limit"));
      send(res, 200, history.read({ since, limit }), { "cache-control": "no-store" });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      send(res, err.status, { error: err.message }, err.headers);
    }
    return true;
  };
}

export const handlePixelsHistory = createHistoryHandler();
