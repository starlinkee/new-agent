import { randomBytes } from "node:crypto";

export const COOKIE_NAME = "pixel_client";
export const DEFAULT_BURST = 10;
export const DEFAULT_REFILL_MS = 2000;

const CLIENT_ID = /^[0-9a-f]{32}$/;
const PRUNE_EVERY = 256;

// Token bucket per client: `burst` tokens, one more every `refillMs`. Buckets are kept in memory
// and dropped once they have refilled completely (an absent bucket is a full one).
export class PaintRateLimiter {
  #burst;
  #refillMs;
  #now;
  #buckets = new Map();
  #calls = 0;

  constructor({ burst = DEFAULT_BURST, refillMs = DEFAULT_REFILL_MS, now = Date.now } = {}) {
    if (!Number.isInteger(burst) || burst < 1) throw new RangeError("burst must be a positive integer");
    if (!(refillMs > 0)) throw new RangeError("refillMs must be positive");
    this.#burst = burst;
    this.#refillMs = refillMs;
    this.#now = now;
  }

  get burst() {
    return this.#burst;
  }

  #refilled(id, now) {
    const bucket = this.#buckets.get(id);
    if (!bucket) return this.#burst;
    return Math.min(this.#burst, bucket.tokens + (now - bucket.at) / this.#refillMs);
  }

  // Takes one token. Returns { allowed, remaining, retryAfterMs }; retryAfterMs is 0 when allowed.
  take(id) {
    const now = this.#now();
    if (++this.#calls % PRUNE_EVERY === 0) this.#prune(now);
    const tokens = this.#refilled(id, now);
    if (tokens < 1) {
      this.#buckets.set(id, { tokens, at: now });
      return { allowed: false, remaining: 0, retryAfterMs: Math.ceil((1 - tokens) * this.#refillMs) };
    }
    this.#buckets.set(id, { tokens: tokens - 1, at: now });
    return { allowed: true, remaining: Math.floor(tokens - 1), retryAfterMs: 0 };
  }

  #prune(now) {
    for (const id of this.#buckets.keys()) {
      if (this.#refilled(id, now) >= this.#burst) this.#buckets.delete(id);
    }
  }
}

export function newClientId() {
  return randomBytes(16).toString("hex");
}

// Returns the client's id from the pixel_client cookie, or null when missing or malformed.
export function readClientId(req) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return CLIENT_ID.test(value) ? value : null;
    }
  }
  return null;
}

export function clientCookie(id) {
  return `${COOKIE_NAME}=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
}
