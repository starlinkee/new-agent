import { HttpError, readJson, send } from "./http.js";
import { PaintRateLimiter, clientCookie, newClientId, readClientId } from "./pixels-ratelimit.js";

export const BOARD_WIDTH = 64;
export const BOARD_HEIGHT = 64;
export const PALETTE = [
  "#000000", "#ffffff", "#9e9e9e", "#5c5c5c",
  "#e53935", "#fb8c00", "#fdd835", "#7cb342",
  "#2e7d32", "#26c6da", "#1e88e5", "#283593",
  "#8e24aa", "#ec407a", "#8d6e63", "#ffccbc",
];
// A paint request is tiny ({"x":63,"y":63,"color":15}); this is a pixels decision, not a todos one.
export const MAX_PIXEL_BODY_BYTES = 1024;

const HEX = "0123456789abcdef";

// In-memory board. Colours are palette indexes; each pixel remembers when it was last painted.
export class PixelStore {
  #colors = new Uint8Array(BOARD_WIDTH * BOARD_HEIGHT);
  #updatedAt = new Array(BOARD_WIDTH * BOARD_HEIGHT).fill(null);
  // ASCII hex digit per pixel, kept in sync with #colors so serialize() does no per-pixel work.
  #hex = new Uint8Array(BOARD_WIDTH * BOARD_HEIGHT).fill(HEX.charCodeAt(0));
  #serialized = null;
  #listeners = new Set();

  get width() {
    return BOARD_WIDTH;
  }

  get height() {
    return BOARD_HEIGHT;
  }

  get palette() {
    return [...PALETTE];
  }

  inRange(x, y) {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < BOARD_WIDTH && y >= 0 && y < BOARD_HEIGHT;
  }

  get(x, y) {
    if (!this.inRange(x, y)) return undefined;
    const i = y * BOARD_WIDTH + x;
    return { x, y, color: this.#colors[i], updatedAt: this.#updatedAt[i] };
  }

  // Row-major, one hex digit (palette index) per pixel. Cached until the next paint.
  serialize() {
    this.#serialized ??= Buffer.from(this.#hex.buffer, this.#hex.byteOffset, this.#hex.length).toString("latin1");
    return this.#serialized;
  }

  paint(x, y, color) {
    if (!this.inRange(x, y)) throw new RangeError("pixel out of range");
    if (!Number.isInteger(color) || color < 0 || color >= PALETTE.length) throw new RangeError("colour out of range");
    const i = y * BOARD_WIDTH + x;
    const updatedAt = new Date().toISOString();
    this.#colors[i] = color;
    this.#hex[i] = HEX.charCodeAt(color);
    this.#serialized = null;
    this.#updatedAt[i] = updatedAt;
    const change = { x, y, color, updatedAt };
    // The paint is committed: a failing listener must not turn it into an error for the painter.
    for (const listener of [...this.#listeners]) {
      try {
        listener({ ...change });
      } catch (err) {
        console.error("pixel listener failed", err);
      }
    }
    return change;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export const pixelStore = new PixelStore();

function parseCoordinate(value, name, max) {
  if (value === null || !/^\d+$/.test(value) || Number(value) >= max) {
    throw new HttpError(400, `${name} must be an integer between 0 and ${max - 1}`);
  }
  return Number(value);
}

function requireInteger(value, name, max) {
  if (!Number.isInteger(value) || value < 0 || value >= max) {
    throw new HttpError(400, `${name} must be an integer between 0 and ${max - 1}`);
  }
  return value;
}

async function route(store, limiter, clientId, req, res, url) {
  const read = req.method === "GET" || req.method === "HEAD";
  if (url.pathname === "/api/pixels/at") {
    if (!read) throw new HttpError(405, "method not allowed", { allow: "GET, HEAD" });
    const x = parseCoordinate(url.searchParams.get("x"), "x", BOARD_WIDTH);
    const y = parseCoordinate(url.searchParams.get("y"), "y", BOARD_HEIGHT);
    return send(res, 200, store.get(x, y), { "cache-control": "no-store" });
  }
  if (read) {
    return send(
      res,
      200,
      { width: store.width, height: store.height, palette: store.palette, pixels: store.serialize() },
      { "cache-control": "no-store" },
    );
  }
  if (req.method === "POST") {
    const grant = limiter.take(clientId);
    if (!grant.allowed) {
      throw new HttpError(429, "too many paints, slow down", {
        "retry-after": String(Math.ceil(grant.retryAfterMs / 1000)),
        "x-ratelimit-remaining": "0",
      }, { retryAfterMs: grant.retryAfterMs });
    }
    res.setHeader("x-ratelimit-remaining", String(grant.remaining));
    const body = await readJson(req, { maxBytes: MAX_PIXEL_BODY_BYTES });
    const x = requireInteger(body.x, "x", BOARD_WIDTH);
    const y = requireInteger(body.y, "y", BOARD_HEIGHT);
    const color = requireInteger(body.color, "color", PALETTE.length);
    return send(res, 200, store.paint(x, y, color));
  }
  throw new HttpError(405, "method not allowed", { allow: "GET, HEAD, POST" });
}

// Returns a handler for /api/pixels requests: resolves true when the request was handled.
// Options: burst / refillMs configure the per-client paint bucket (default 10 paints, +1 per 2s).
export function createPixelHandler(store = pixelStore, { burst, refillMs, now } = {}) {
  const limiter = new PaintRateLimiter({ burst, refillMs, now });
  return async function handlePixels(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return false;
    }
    if (!/^\/api\/pixels(?:\/at)?\/?$/.test(url.pathname)) return false;
    if (url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    let clientId = readClientId(req);
    if (!clientId) {
      clientId = newClientId();
      res.setHeader("set-cookie", clientCookie(clientId));
    }
    try {
      await route(store, limiter, clientId, req, res, url);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (res.headersSent) return true;
      send(res, err.status, { error: err.message, ...err.extra }, err.headers);
      if (err.status === 413) res.once("finish", () => req.destroy());
    }
    return true;
  };
}

export const handlePixels = createPixelHandler();
