import { HttpError, readJson, send } from "./todos.js";

export const BOARD_WIDTH = 64;
export const BOARD_HEIGHT = 64;
export const PALETTE = [
  "#000000", "#ffffff", "#9e9e9e", "#5c5c5c",
  "#e53935", "#fb8c00", "#fdd835", "#7cb342",
  "#2e7d32", "#26c6da", "#1e88e5", "#283593",
  "#8e24aa", "#ec407a", "#8d6e63", "#ffccbc",
];

// In-memory board. Colours are palette indexes; each pixel remembers when it was last painted.
export class PixelStore {
  #colors = new Uint8Array(BOARD_WIDTH * BOARD_HEIGHT);
  #updatedAt = new Array(BOARD_WIDTH * BOARD_HEIGHT).fill(null);
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

  // Row-major, one hex digit (palette index) per pixel.
  serialize() {
    return Array.from(this.#colors, (c) => c.toString(16)).join("");
  }

  paint(x, y, color) {
    if (!this.inRange(x, y)) throw new RangeError("pixel out of range");
    if (!Number.isInteger(color) || color < 0 || color >= PALETTE.length) throw new RangeError("colour out of range");
    const i = y * BOARD_WIDTH + x;
    const updatedAt = new Date().toISOString();
    this.#colors[i] = color;
    this.#updatedAt[i] = updatedAt;
    const change = { x, y, color, updatedAt };
    for (const listener of [...this.#listeners]) listener({ ...change });
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

async function route(store, req, res, url) {
  const isAt = url.pathname === "/api/pixels/at";
  if (isAt) {
    if (req.method !== "GET") throw new HttpError(405, "method not allowed", { allow: "GET" });
    const x = parseCoordinate(url.searchParams.get("x"), "x", store.width);
    const y = parseCoordinate(url.searchParams.get("y"), "y", store.height);
    return send(res, 200, store.get(x, y), { "cache-control": "no-store" });
  }
  if (req.method === "GET") {
    return send(
      res,
      200,
      { width: store.width, height: store.height, palette: store.palette, pixels: store.serialize() },
      { "cache-control": "no-store" },
    );
  }
  if (req.method === "POST") {
    const body = await readJson(req);
    const x = requireInteger(body.x, "x", store.width);
    const y = requireInteger(body.y, "y", store.height);
    const color = requireInteger(body.color, "color", store.palette.length);
    return send(res, 200, store.paint(x, y, color));
  }
  throw new HttpError(405, "method not allowed", { allow: "GET, POST" });
}

// Returns a handler for /api/pixels requests: resolves true when the request was handled.
export function createPixelHandler(store = pixelStore) {
  return async function handlePixels(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      send(res, 400, { error: "malformed request target" });
      return true;
    }
    if (!/^\/api\/pixels(?:\/at)?\/?$/.test(url.pathname)) return false;
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    try {
      await route(store, req, res, url);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (res.headersSent) return true;
      send(res, err.status, { error: err.message }, err.headers);
      if (err.status === 413) res.once("finish", () => req.destroy());
    }
    return true;
  };
}

export const handlePixels = createPixelHandler();
