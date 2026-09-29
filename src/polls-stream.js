import { send } from "./http.js";
import { pollStore } from "./polls.js";

export const PING_INTERVAL_MS = 25_000;

const EVENTS_PATH = /^\/api\/polls\/([^/]+)\/events$/;

// Returns a handler for GET /api/polls/<id>/events: resolves true when the request was handled.
export function createPollStreamHandler(store = pollStore, { pingMs = PING_INTERVAL_MS } = {}) {
  return async function handlePollStream(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return false;
    }
    const match = EVENTS_PATH.exec(pathname);
    if (!match) return false;
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed" }, { allow: "GET" });
      return true;
    }
    const poll = store.get(match[1]);
    if (!poll) {
      send(res, 404, { error: "poll not found" });
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
    res.write(`event: snapshot\ndata: ${JSON.stringify({ tallies: poll.tallies, total: poll.total })}\n\n`);
    const unsubscribe = store.subscribe((event) => {
      if (event.type !== "vote" || event.pollId !== poll.id) return;
      const { tallies, total, at } = event;
      res.write(`event: vote\ndata: ${JSON.stringify({ tallies, total, at })}\n\n`);
    });
    const timer = setInterval(() => res.write(": ping\n\n"), pingMs);
    res.on("close", () => {
      clearInterval(timer);
      unsubscribe();
    });
    return true;
  };
}

export const handlePollStream = createPollStreamHandler();
