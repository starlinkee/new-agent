import { randomBytes } from "node:crypto";
import { HttpError, readJson, send } from "./http.js";
import { register } from "node:module";

// predators.js imports its sibling as "/static/world-sim.js" (a browser URL); teach Node to resolve that first.
register("./biome-loader.js", import.meta.url);
const { createWorld, step: stepWorld, mulberry32 } = await import("./static/world-sim.js");
const { enablePredators } = await import("./static/predators.js");
const { createEvents } = await import("./static/events.js");
const { ECOSYSTEM_EVENTS } = await import("./static/events-ecosystem.js");
const { createAtmosphere } = await import("./static/atmosphere.js");

export const TICK_MS = 100;
export const COOKIE_NAME = "biome_client";
export const MAX_BODY_BYTES = 1024;
export const MAX_NAME_LENGTH = 16;
export const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899"];
export const DEFAULT_POSE = Object.freeze({ x: 0, y: 420, z: 520, yaw: 0, pitch: -0.7 });

const BUILT_IN_EVENTS = new Set(["tick", "joined", "left", "happening"]);
const MAX_STEP_MS = 400;
const CLIENT_ID = /^[0-9a-f]{32}$/;

const round1 = (value) => Math.round(value * 10) / 10;
const round2 = (value) => Math.round(value * 100) / 100;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const orNull = (value, round) => (typeof value === "number" ? round(value) : null);

function wrapAngle(angle) {
  const wrapped = angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));
  // Floor maps PI to -PI; the range is (-PI, PI].
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

// One shared world plus the observers looking at it. Does not tick on its own: callers drive it with step(dtMs).
export class Biome {
  #width;
  #height;
  #idleMs;
  #maxObservers;
  #now;
  #atmosphere;
  #observers = new Map();
  #listeners = new Set();
  #announced = new WeakSet();
  #tick = 0;
  #colorCursor = 0;

  constructor({ width = 900, height = 900, creatures = 20, seed, idleMs = 60000, maxObservers = 100, now = Date.now } = {}) {
    this.#width = width;
    this.#height = height;
    this.#idleMs = idleMs;
    this.#maxObservers = maxObservers;
    this.#now = now;
    const seeded = seed !== undefined;
    this.world = createWorld({ width, height, count: creatures, ...(seeded && { seed }) });
    enablePredators(this.world);
    this.events = createEvents({ ...(seeded && { seed: seed + 1 }), extensions: ECOSYSTEM_EVENTS });
    this.#atmosphere = createAtmosphere(seeded ? { random: mulberry32(seed + 2) } : {});
  }

  #at() {
    return new Date(this.#now()).toISOString();
  }

  #view(observer) {
    const { x, y, z, yaw, pitch } = observer.pose;
    return {
      id: observer.id,
      name: observer.name,
      color: observer.color,
      pose: { x: round1(x), y: round1(y), z: round1(z), yaw: round2(yaw), pitch: round2(pitch) },
    };
  }

  #emit(event) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error("biome listener failed:", err);
      }
    }
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // Sends a leaf event to every listener. Built-in types are reserved for the biome itself.
  publish(event) {
    if (typeof event?.type !== "string" || BUILT_IN_EVENTS.has(event.type)) {
      throw new TypeError(`event.type must be a string other than ${[...BUILT_IN_EVENTS].join(", ")}`);
    }
    this.#emit({ ...event, at: this.#at() });
  }

  #newId() {
    let id;
    do id = randomBytes(4).toString("hex");
    while (this.#observers.has(id));
    return id;
  }

  observe({ name, clientId } = {}) {
    if (clientId !== undefined) {
      const existing = this.observerOf(clientId);
      if (existing) this.leave(existing.id, "rejoin");
    }
    if (this.#observers.size >= this.#maxObservers) throw new HttpError(503, "too many observers");
    const observer = {
      id: this.#newId(),
      name,
      clientId,
      color: COLORS[this.#colorCursor++ % COLORS.length],
      pose: { ...DEFAULT_POSE },
      lastPose: this.#now(),
    };
    this.#observers.set(observer.id, observer);
    const view = this.#view(observer);
    this.#emit({ type: "joined", observer: view, at: this.#at() });
    return view;
  }

  setPose(id, pose) {
    const observer = this.#observers.get(id);
    if (!observer) return false;
    observer.pose = {
      x: clamp(pose.x, -this.#width, this.#width),
      y: clamp(pose.y, 5, 2000),
      z: clamp(pose.z, -this.#height, this.#height),
      yaw: wrapAngle(pose.yaw),
      pitch: clamp(pose.pitch, -1.55, 1.55),
    };
    observer.lastPose = this.#now();
    return true;
  }

  leave(id, reason = "leave") {
    const observer = this.#observers.get(id);
    if (!observer) return false;
    this.#observers.delete(id);
    this.#emit({ type: "left", observer: this.#view(observer), reason, at: this.#at() });
    return true;
  }

  get(id) {
    const observer = this.#observers.get(id);
    return observer ? this.#view(observer) : undefined;
  }

  observerOf(clientId) {
    if (clientId === undefined || clientId === null) return undefined;
    for (const observer of this.#observers.values()) {
      if (observer.clientId === clientId) return this.#view(observer);
    }
    return undefined;
  }

  snapshot() {
    const atmosphere = this.#atmosphere;
    return {
      tick: this.#tick,
      width: this.#width,
      height: this.#height,
      sky: { time: Math.round(atmosphere.time() * 1000) / 1000, phase: atmosphere.phase(), weather: atmosphere.weather() },
      creatures: this.world.creatures.map((c) => ({
        id: c.id,
        species: c.species,
        x: round1(c.x),
        y: round1(c.y),
        heading: round2(c.heading),
        radius: round1(c.radius),
        hue: round1(c.hue),
        energy: round1(c.energy),
        generation: c.generation,
        age: round1(c.age),
      })),
      food: this.world.food.map((f) => [Math.round(f.x), Math.round(f.y)]),
      effects: this.events.effects.map((e) => ({
        type: e.type,
        x: orNull(e.x, round1),
        y: orNull(e.y, round1),
        radius: orNull(e.radius, round1),
        age: round1(e.age),
        duration: round1(e.duration),
      })),
      observers: [...this.#observers.values()].map((observer) => this.#view(observer)),
    };
  }

  step(dtMs) {
    const dt = Math.min(dtMs, MAX_STEP_MS) / 1000;
    this.events.update(this.world, dt);
    stepWorld(this.world, dt);
    this.#atmosphere.update(dt, this.#width, this.#height);
    const now = this.#now();
    for (const observer of [...this.#observers.values()]) {
      if (now - observer.lastPose >= this.#idleMs) this.leave(observer.id, "idle");
    }
    for (const entry of this.world.log) {
      if (entry.kind !== "event" || this.#announced.has(entry)) continue;
      this.#announced.add(entry);
      this.#emit({ type: "happening", eventType: entry.type, text: entry.text, at: this.#at() });
    }
    this.#tick += 1;
    this.#emit({ type: "tick", tick: this.#tick, at: this.#at() });
  }
}

export const biome = new Biome();

let lastTickAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = clamp(now - lastTickAt, 1, MAX_STEP_MS);
  lastTickAt = now;
  biome.step(dt);
}, TICK_MS).unref();

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

function clientCookie(id) {
  return `${COOKIE_NAME}=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
}

function methodNotAllowed(allow) {
  return new HttpError(405, "method not allowed", { allow });
}

function validateName(body) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "" || name.length > MAX_NAME_LENGTH) {
    throw new HttpError(400, `name must be a string of 1-${MAX_NAME_LENGTH} characters`);
  }
  return name;
}

const POSE_FIELDS = ["x", "y", "z", "yaw", "pitch"];

// Returns a handler for /api/biome/observe, /pose, /leave and /state: resolves true when handled.
export function createBiomeHandler(store = biome) {
  async function route(action, req, res, clientId, headers) {
    if (action === "state") {
      if (req.method !== "GET") throw methodNotAllowed("GET");
      return send(res, 200, { ...store.snapshot(), me: store.observerOf(clientId)?.id ?? null }, headers);
    }
    if (req.method !== "POST") throw methodNotAllowed("POST");
    if (action === "leave") {
      const observer = store.observerOf(clientId);
      if (observer) store.leave(observer.id);
      return send(res, 204, undefined, headers);
    }
    const body = await readJson(req, { maxBytes: MAX_BODY_BYTES });
    if (action === "observe") {
      const view = store.observe({ name: validateName(body), clientId });
      return send(res, 201, view, headers);
    }
    if (!POSE_FIELDS.every((key) => typeof body[key] === "number" && Number.isFinite(body[key]))) {
      throw new HttpError(400, "x, y, z, yaw and pitch must be finite numbers");
    }
    const observer = store.observerOf(clientId);
    if (!observer || !store.setPose(observer.id, body)) throw new HttpError(404, "not observing");
    return send(res, 204, undefined, headers);
  }

  return async function handleBiome(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return false;
    }
    const match = /^\/api\/biome\/(observe|pose|leave|state)\/?$/.exec(url.pathname);
    if (!match) return false;
    let clientId = readClientId(req);
    const headers = {};
    if (!clientId) {
      clientId = randomBytes(16).toString("hex");
      headers["set-cookie"] = clientCookie(clientId);
    }
    try {
      await route(match[1], req, res, clientId, headers);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (res.headersSent) return true;
      send(res, err.status, { error: err.message }, { ...headers, ...err.headers });
      if (err.status === 413) res.once("finish", () => req.destroy());
    }
    return true;
  };
}

export const handleBiome = createBiomeHandler();
