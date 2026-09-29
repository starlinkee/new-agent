import { arena } from "./blobs.js";
import { send } from "./http.js";

export const TOP_SIZE = 10;
export const RECENT_SIZE = 10;

// Records the peak mass of every human that is eaten or leaves. Returns { handler, top(n), recent(n), stop() };
// handler serves GET /api/blobs/scores and resolves true when the request was handled.
export function createBlobScores(store = arena, { max = 100, now = Date.now } = {}) {
  let best = []; // the best `max` entries, mass desc, ties older first
  let newest = []; // the newest RECENT_SIZE entries, oldest first

  const record = (player) => {
    if (!player || player.bot) return;
    const entry = { name: player.name, mass: player.peakMass, at: now() };
    newest.push(entry);
    if (newest.length > RECENT_SIZE) newest.shift();
    let index = best.length;
    while (index > 0 && best[index - 1].mass < entry.mass) index -= 1;
    best.splice(index, 0, entry);
    if (best.length > max) best.pop();
  };

  const unsubscribe = store.subscribe((event) => {
    if (event.type === "eaten") record(event.victim);
    else if (event.type === "left") record(event.player);
  });

  const top = (n = TOP_SIZE) => best.slice(0, n).map((entry) => ({ ...entry }));
  const recent = (n = RECENT_SIZE) => newest.slice(-n).reverse().map((entry) => ({ ...entry }));

  async function handler(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return false;
    }
    if (pathname !== "/api/blobs/scores") return false;
    if (req.method !== "GET") {
      send(res, 405, { error: "method not allowed" }, { allow: "GET" });
    } else {
      send(res, 200, { top: top(TOP_SIZE), recent: recent(RECENT_SIZE) }, { "cache-control": "no-store" });
    }
    return true;
  }

  return { handler, top, recent, stop: unsubscribe };
}

export const handleBlobScores = createBlobScores().handler;
