import { HttpError } from "./todos.js";

export const MAX_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_SNAPSHOTS = 20;
export const MAX_NAME_LENGTH = 60;
// Request body = data (<= MAX_SNAPSHOT_BYTES) plus room for the name and JSON framing.
const MAX_BODY_BYTES = MAX_SNAPSHOT_BYTES + 4 * 1024;

// Summary shown in list views, computed once at save time so listing never needs the blobs.
function summarize(value) {
  const data = value !== null && typeof value === "object" ? value : {};
  return {
    time: Number.isFinite(data.time) ? data.time : 0,
    creatureCount: Array.isArray(data.creatures) ? data.creatures.length : 0,
  };
}

// In-memory store. Ids are unique and never reused; the oldest snapshot is evicted past the cap.
export class SnapshotStore {
  #snapshots = new Map();
  #nextId = 1;

  list() {
    return [...this.#snapshots.values()].map(({ data, ...meta }) => meta);
  }

  get(id) {
    const snapshot = this.#snapshots.get(id);
    return snapshot ? { ...snapshot } : undefined;
  }

  create(name, data, size) {
    const snapshot = { id: this.#nextId++, name, savedAt: new Date().toISOString(), size, ...summarize(data), data };
    this.#snapshots.set(snapshot.id, snapshot);
    while (this.#snapshots.size > MAX_SNAPSHOTS) {
      this.#snapshots.delete(this.#snapshots.keys().next().value);
    }
    const { data: _data, ...meta } = snapshot;
    return meta;
  }

  delete(id) {
    return this.#snapshots.delete(id);
  }
}

function send(res, status, body, headers = {}) {
  const base = { "x-content-type-options": "nosniff", ...headers };
  if (body === undefined) {
    res.writeHead(status, base);
    res.end();
    return;
  }
  res.writeHead(status, { ...base, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return Promise.reject(new HttpError(415, "content-type must be application/json"));
  }
  const tooLarge = () => new HttpError(413, "payload too large", { connection: "close" });
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) return Promise.reject(tooLarge());
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        fail(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reject(new HttpError(400, "malformed JSON"));
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return reject(new HttpError(400, "body must be a JSON object"));
      }
      resolve(parsed);
    });
    req.on("aborted", () => fail(new HttpError(400, "request aborted")));
    req.on("close", () => fail(new HttpError(400, "request aborted")));
    req.on("error", () => fail(new HttpError(400, "request error")));
  });
}

function validateCreate(body) {
  if (typeof body.name !== "string" || body.name.trim() === "") {
    throw new HttpError(400, "name must be a non-empty string");
  }
  const name = body.name.trim();
  if (name.length > MAX_NAME_LENGTH) {
    throw new HttpError(400, `name must be at most ${MAX_NAME_LENGTH} characters`);
  }
  const { data } = body;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "data must be a JSON object");
  }
  const size = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (size > MAX_SNAPSHOT_BYTES) {
    throw new HttpError(413, "snapshot too large", { connection: "close" });
  }
  return { name, data, size };
}

async function route(store, req, res, id) {
  if (id === undefined) {
    if (req.method === "GET") return send(res, 200, store.list());
    if (req.method === "POST") {
      const { name, data, size } = validateCreate(await readJson(req));
      return send(res, 201, store.create(name, data, size));
    }
    throw new HttpError(405, "method not allowed", { allow: "GET, POST" });
  }

  if (req.method !== "GET" && req.method !== "DELETE") {
    throw new HttpError(405, "method not allowed", { allow: "GET, DELETE" });
  }
  const numericId = /^\d+$/.test(id) ? Number(id) : NaN;
  const snapshot = Number.isNaN(numericId) ? undefined : store.get(numericId);
  if (!snapshot) throw new HttpError(404, "snapshot not found");
  if (req.method === "GET") return send(res, 200, snapshot);
  store.delete(numericId);
  return send(res, 204);
}

// Returns a handler for /api/world/snapshots requests: resolves true when the request was handled.
export function createSnapshotHandler(store = new SnapshotStore()) {
  return async function handleSnapshots(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      send(res, 400, { error: "malformed request target" });
      return true;
    }
    const match = /^\/api\/world\/snapshots(?:\/([^/]+))?\/?$/.exec(url.pathname);
    if (!match) return false;
    try {
      await route(store, req, res, match[1]);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (res.headersSent) return true;
      send(res, err.status, { error: err.message }, err.headers);
      if (err.status === 413) res.once("finish", () => req.destroy());
    }
    return true;
  };
}

export const handleSnapshots = createSnapshotHandler();
