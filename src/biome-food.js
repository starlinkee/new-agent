import { HttpError, readJson, send } from "./http.js";
import { biome, readClientId, MAX_BODY_BYTES } from "./biome.js";
import { addFood } from "./static/world-sim.js";

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

// Returns a handler for POST /api/biome/food: resolves true when the request was handled.
// Each biome_client cookie gets a token bucket: `burst` drops, one more every `refillMs`.
export function createBiomeFoodHandler({ store = biome, burst = 5, refillMs = 1000 } = {}) {
  const buckets = new Map();

  // Refills the bucket for `clientId` up to now and returns it.
  function bucketFor(clientId, now) {
    const bucket = buckets.get(clientId) ?? { tokens: burst, at: now };
    bucket.tokens = Math.min(burst, bucket.tokens + (now - bucket.at) / refillMs);
    bucket.at = now;
    buckets.set(clientId, bucket);
    return bucket;
  }

  function forgetFullBuckets(now) {
    for (const [clientId, bucket] of buckets) {
      if (bucket.tokens + (now - bucket.at) / refillMs >= burst) buckets.delete(clientId);
    }
  }

  async function drop(req, res) {
    if (req.method !== "POST") throw new HttpError(405, "method not allowed", { allow: "POST" });
    const body = await readJson(req, { maxBytes: MAX_BODY_BYTES });
    const { width, height } = store.snapshot();
    if (!isNumber(body.x) || !isNumber(body.y) || body.x < 0 || body.x > width || body.y < 0 || body.y > height) {
      throw new HttpError(400, `x and y must be numbers inside 0..${width} and 0..${height}`);
    }
    const clientId = readClientId(req);
    const observer = store.observerOf(clientId);
    if (!observer) throw new HttpError(404, "not observing");

    const now = Date.now();
    forgetFullBuckets(now);
    const bucket = bucketFor(clientId, now);
    if (bucket.tokens < 1) {
      const retryAfterMs = Math.ceil((1 - bucket.tokens) * refillMs);
      throw new HttpError(429, "slow down: too many drops", { "retry-after": String(Math.ceil(retryAfterMs / 1000)) }, { retryAfterMs });
    }
    if (!addFood(store.world, body.x, body.y)) throw new HttpError(409, "food is full");
    bucket.tokens -= 1;
    store.publish({ type: "food", x: body.x, y: body.y, observerId: observer.id, color: observer.color });
    send(res, 201, { x: body.x, y: body.y });
  }

  return async function handleBiomeFood(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return false;
    }
    if (!/^\/api\/biome\/food\/?$/.test(pathname)) return false;
    try {
      await drop(req, res);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (res.headersSent) return true;
      send(res, err.status, { error: err.message, ...err.extra }, err.headers);
      if (err.status === 413) res.once("finish", () => req.destroy());
    }
    return true;
  };
}

export const handleBiomeFood = createBiomeFoodHandler();
