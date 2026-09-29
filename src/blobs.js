import { randomBytes } from "node:crypto";
import { HttpError, readJson, send } from "./http.js";

export const TICK_MS = 50;
export const COOKIE_NAME = "blobs_client";
export const MAX_BODY_BYTES = 1024;
export const MAX_NAME_LENGTH = 16;
export const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899"];

const EAT_RATIO = 1.25;
const DEFAULT_MAX_MASS = 2000;
const MAX_TICK_DT_MS = TICK_MS * 4;
const CLIENT_ID = /^[0-9a-f]{32}$/;

export function radiusFor(mass) {
  return 4 * Math.sqrt(mass);
}

const round1 = (value) => Math.round(value * 10) / 10;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// In-memory arena. Does not tick on its own: callers drive it with step(dtMs).
export class Arena {
  #width;
  #height;
  #foodCount;
  #startMass;
  #maxPlayers;
  #idleMs;
  #rng;
  #now;
  #players = new Map();
  #food = [];
  #listeners = new Set();
  #tick = 0;

  constructor({
    width = 2000,
    height = 2000,
    foodCount = 150,
    startMass = 20,
    maxPlayers = 50,
    idleMs = 30000,
    rng = Math.random,
    now = Date.now,
  } = {}) {
    this.#width = width;
    this.#height = height;
    this.#foodCount = foodCount;
    this.#startMass = startMass;
    this.#maxPlayers = maxPlayers;
    this.#idleMs = idleMs;
    this.#rng = rng;
    this.#now = now;
    this.#refillFood();
  }

  #at() {
    return new Date(this.#now()).toISOString();
  }

  #view(player) {
    return {
      id: player.id,
      name: player.name,
      color: player.color,
      x: round1(player.x),
      y: round1(player.y),
      mass: round1(player.mass),
      radius: round1(radiusFor(player.mass)),
      bot: player.bot,
      peakMass: round1(player.peakMass),
    };
  }

  #emit(event) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error("blobs listener failed:", err);
      }
    }
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #newId() {
    let id;
    do id = randomBytes(4).toString("hex");
    while (this.#players.has(id));
    return id;
  }

  #grow(player, amount) {
    player.mass = Math.min(player.maxMass, player.mass + amount);
    player.peakMass = Math.max(player.peakMass, player.mass);
  }

  join({ name, bot = false, x, y, mass, maxMass } = {}) {
    if (!bot) {
      let humans = 0;
      for (const player of this.#players.values()) if (!player.bot) humans += 1;
      if (humans >= this.#maxPlayers) throw new HttpError(503, "arena full");
    }
    const cap = maxMass ?? DEFAULT_MAX_MASS;
    const startMass = Math.min(cap, mass ?? this.#startMass);
    const px = clamp(x ?? this.#rng() * this.#width, 0, this.#width);
    const py = clamp(y ?? this.#rng() * this.#height, 0, this.#height);
    const player = {
      id: this.#newId(),
      name,
      color: COLORS[Math.floor(this.#rng() * COLORS.length) % COLORS.length],
      x: px,
      y: py,
      tx: px,
      ty: py,
      mass: startMass,
      maxMass: cap,
      peakMass: startMass,
      bot: Boolean(bot),
      lastInput: this.#now(),
    };
    this.#players.set(player.id, player);
    const view = this.#view(player);
    this.#emit({ type: "joined", player: view, at: this.#at() });
    return view;
  }

  leave(id, reason = "leave") {
    const player = this.#players.get(id);
    if (!player) return false;
    this.#players.delete(id);
    this.#emit({ type: "left", player: this.#view(player), reason, at: this.#at() });
    return true;
  }

  setTarget(id, x, y) {
    const player = this.#players.get(id);
    if (!player) return false;
    player.tx = clamp(x, 0, this.#width);
    player.ty = clamp(y, 0, this.#height);
    player.lastInput = this.#now();
    return true;
  }

  get(id) {
    const player = this.#players.get(id);
    return player ? this.#view(player) : undefined;
  }

  spawnFood(x, y) {
    this.#food.push([clamp(x, 0, this.#width), clamp(y, 0, this.#height)]);
  }

  snapshot() {
    return {
      tick: this.#tick,
      width: this.#width,
      height: this.#height,
      players: [...this.#players.values()].map((player) => this.#view(player)),
      food: this.#food.map(([x, y]) => [Math.round(x), Math.round(y)]),
    };
  }

  #refillFood() {
    while (this.#food.length < this.#foodCount) {
      this.#food.push([this.#rng() * this.#width, this.#rng() * this.#height]);
    }
  }

  #move(player, dtMs) {
    const speed = 240 * (20 / player.mass) ** 0.4;
    const dx = player.tx - player.x;
    const dy = player.ty - player.y;
    const dist = Math.hypot(dx, dy);
    const reach = (speed * dtMs) / 1000;
    if (dist <= reach) {
      player.x = player.tx;
      player.y = player.ty;
    } else {
      player.x += (dx / dist) * reach;
      player.y += (dy / dist) * reach;
    }
    player.x = clamp(player.x, 0, this.#width);
    player.y = clamp(player.y, 0, this.#height);
  }

  #eatFood(player) {
    const radius = radiusFor(player.mass);
    this.#food = this.#food.filter(([fx, fy]) => {
      if (Math.hypot(fx - player.x, fy - player.y) > radius) return true;
      this.#grow(player, 1);
      return false;
    });
  }

  #eatPlayers() {
    const byMass = [...this.#players.values()].sort((a, b) => b.mass - a.mass);
    for (const eater of byMass) {
      if (!this.#players.has(eater.id)) continue;
      for (const victim of byMass) {
        if (victim === eater || !this.#players.has(victim.id)) continue;
        if (eater.mass < EAT_RATIO * victim.mass) continue;
        if (Math.hypot(victim.x - eater.x, victim.y - eater.y) > radiusFor(eater.mass)) continue;
        this.#players.delete(victim.id);
        this.#grow(eater, victim.mass);
        this.#emit({ type: "eaten", eater: this.#view(eater), victim: this.#view(victim), at: this.#at() });
      }
    }
  }

  step(dtMs) {
    const players = [...this.#players.values()];
    for (const player of players) this.#move(player, dtMs);
    for (const player of players) this.#eatFood(player);
    this.#eatPlayers();
    const now = this.#now();
    for (const player of [...this.#players.values()]) {
      if (!player.bot && now - player.lastInput >= this.#idleMs) this.leave(player.id, "idle");
    }
    this.#refillFood();
    this.#tick += 1;
    this.#emit({ type: "tick", tick: this.#tick, at: this.#at() });
  }
}

export const arena = new Arena();

let lastTickAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = clamp(now - lastTickAt, 1, MAX_TICK_DT_MS);
  lastTickAt = now;
  arena.step(dt);
}, TICK_MS).unref();

function readClientId(req) {
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

// Returns a handler for /api/blobs/join, /target, /leave and /state: resolves true when handled.
export function createBlobHandler(store = arena) {
  // One live player per client cookie; entries are dropped when the player leaves or is eaten.
  const playerByClient = new Map();
  const clientByPlayer = new Map();
  const forget = (playerId) => {
    const clientId = clientByPlayer.get(playerId);
    if (clientId === undefined) return;
    clientByPlayer.delete(playerId);
    playerByClient.delete(clientId);
  };
  store.subscribe((event) => {
    if (event.type === "left") forget(event.player.id);
    else if (event.type === "eaten") forget(event.victim.id);
  });

  async function route(action, req, res, clientId, headers) {
    if (action === "state") {
      if (req.method !== "GET") throw methodNotAllowed("GET");
      return send(res, 200, { ...store.snapshot(), me: playerByClient.get(clientId) ?? null }, headers);
    }
    if (req.method !== "POST") throw methodNotAllowed("POST");
    if (action === "leave") {
      const playerId = playerByClient.get(clientId);
      if (playerId !== undefined) store.leave(playerId);
      return send(res, 204, undefined, headers);
    }
    const body = await readJson(req, { maxBytes: MAX_BODY_BYTES });
    if (action === "join") {
      const name = validateName(body);
      const previous = playerByClient.get(clientId);
      if (previous !== undefined) store.leave(previous, "rejoin");
      const player = store.join({ name });
      playerByClient.set(clientId, player.id);
      clientByPlayer.set(player.id, clientId);
      return send(res, 201, player, headers);
    }
    const { x, y } = body;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new HttpError(400, "x and y must be finite numbers");
    }
    const playerId = playerByClient.get(clientId);
    if (playerId === undefined || !store.setTarget(playerId, x, y)) throw new HttpError(404, "not playing");
    return send(res, 204, undefined, headers);
  }

  return async function handleBlobs(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return false;
    }
    const match = /^\/api\/blobs\/(join|target|leave|state)\/?$/.exec(url.pathname);
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

export const handleBlobs = createBlobHandler();
