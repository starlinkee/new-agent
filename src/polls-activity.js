import { HttpError, send } from "./http.js";
import { pollStore } from "./polls.js";

export const MAX_VOTES_PER_POLL = 5000;
export const MAX_POLLS_TRACKED = 500;
export const MAX_BUCKETS = 60;
export const DEFAULT_BUCKET_SEC = 60;
export const MAX_BUCKET_SEC = 3600;

// Vote times (ms) per poll id, oldest first. Map order is insertion order, so the oldest poll is dropped first.
const votesByPoll = new Map();
let subscribedStore = null;
let unsubscribe = null;

function record(event) {
  if (event.type !== "vote") return;
  const at = Date.parse(event.at);
  if (Number.isNaN(at)) return;
  let times = votesByPoll.get(event.pollId);
  if (!times) {
    times = [];
    votesByPoll.set(event.pollId, times);
    while (votesByPoll.size > MAX_POLLS_TRACKED) votesByPoll.delete(votesByPoll.keys().next().value);
  }
  times.push(at);
  if (times.length > MAX_VOTES_PER_POLL) times.shift();
}

function parseBucket(value) {
  if (value === null) return DEFAULT_BUCKET_SEC;
  if (!/^\d+$/.test(value)) throw new HttpError(400, `bucket must be an integer between 1 and ${MAX_BUCKET_SEC}`);
  const sec = Number(value);
  if (sec < 1 || sec > MAX_BUCKET_SEC) {
    throw new HttpError(400, `bucket must be an integer between 1 and ${MAX_BUCKET_SEC}`);
  }
  return sec;
}

// Buckets from the first recorded vote to now, oldest first, empty ones included; the newest MAX_BUCKETS at most.
export function buildBuckets(times, bucketSec, now = Date.now()) {
  if (times.length === 0) return [];
  const width = bucketSec * 1000;
  const first = times[0];
  const count = Math.max(1, Math.floor((now - first) / width) + 1);
  const shown = Math.min(count, MAX_BUCKETS);
  const offset = count - shown;
  const votes = new Array(shown).fill(0);
  for (const time of times) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((time - first) / width))) - offset;
    if (index >= 0) votes[index] += 1;
  }
  return votes.map((n, i) => ({ start: new Date(first + (offset + i) * width).toISOString(), votes: n }));
}

// Returns a handler for /api/polls/<id>/activity: resolves true when handled. Records votes from `store`.
export function createPollActivityHandler(store = pollStore) {
  if (subscribedStore !== store) {
    unsubscribe?.();
    votesByPoll.clear();
    unsubscribe = store.subscribe(record);
    subscribedStore = store;
  }
  return async function handlePollActivity(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return false;
    }
    const match = /^\/api\/polls\/([^/]+)\/activity\/?$/.exec(url.pathname);
    if (!match) return false;
    try {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed", { allow: "GET" });
      const bucketSec = parseBucket(url.searchParams.get("bucket"));
      if (!store.get(match[1])) throw new HttpError(404, "poll not found");
      const buckets = buildBuckets(votesByPoll.get(match[1]) ?? [], bucketSec);
      send(res, 200, { bucketSec, buckets }, { "cache-control": "no-store" });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      send(res, err.status, { error: err.message }, err.headers);
    }
    return true;
  };
}

export const handlePollActivity = createPollActivityHandler();
