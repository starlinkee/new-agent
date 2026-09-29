import { biome } from "./biome.js";

export const PING_INTERVAL_MS = 25_000;

// Returns a handler for GET /api/biome/stream: resolves true when the request was handled.
// `state` carries the snapshot after every tick; every other event is forwarded as `event: <type>` without its type.
export function createBiomeStreamHandler(store = biome, { pingMs = PING_INTERVAL_MS } = {}) {
  return async function handleBiomeStream(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return false;
    }
    if (pathname !== "/api/biome/stream") return false;
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
    const unsubscribe = store.subscribe((event) => {
      if (event.type === "tick") {
        res.write(`event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
      } else {
        const { type, ...data } = event;
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    });
    const timer = setInterval(() => res.write(": ping\n\n"), pingMs);
    res.on("close", () => {
      clearInterval(timer);
      unsubscribe();
    });
    return true;
  };
}

export const handleBiomeStream = createBiomeStreamHandler();
