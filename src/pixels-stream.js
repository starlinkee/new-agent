import { pixelStore } from "./pixels.js";

export const PING_INTERVAL_MS = 25_000;

// Returns a handler for GET /api/pixels/stream: resolves true when the request was handled.
export function createPixelStreamHandler(store = pixelStore, { pingMs = PING_INTERVAL_MS } = {}) {
  return async function handlePixelStream(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return false;
    }
    if (pathname !== "/api/pixels/stream") return false;
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET", "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "method not allowed" }));
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
    const unsubscribe = store.subscribe((pixel) => {
      res.write(`event: pixel\ndata: ${JSON.stringify(pixel)}\n\n`);
    });
    const timer = setInterval(() => res.write(": ping\n\n"), pingMs);
    res.on("close", () => {
      clearInterval(timer);
      unsubscribe();
    });
    return true;
  };
}

export const handlePixelStream = createPixelStreamHandler();
