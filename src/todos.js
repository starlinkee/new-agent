import { HttpError, readJson as readJsonBody, send } from "./http.js";

// Re-exported for existing importers (world-snapshots.js).
export { HttpError };

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_TITLE_LENGTH = 500;
export const MAX_TODOS = 1000;

// In-memory store. Ids are unique and never reused for the process lifetime.
export class TodoRepository {
  #todos = new Map();
  #nextId = 1;

  get size() {
    return this.#todos.size;
  }

  list({ limit = MAX_TODOS, offset = 0 } = {}) {
    return [...this.#todos.values()].slice(offset, offset + limit).map((t) => ({ ...t }));
  }

  get(id) {
    const todo = this.#todos.get(id);
    return todo ? { ...todo } : undefined;
  }

  create(title) {
    const todo = { id: this.#nextId++, title, done: false };
    this.#todos.set(todo.id, todo);
    return { ...todo };
  }

  update(id, changes) {
    const todo = this.#todos.get(id);
    if (!todo) return undefined;
    Object.assign(todo, changes);
    return { ...todo };
  }

  delete(id) {
    return this.#todos.delete(id);
  }
}

function normalizeTitle(title) {
  if (typeof title !== "string" || title.trim() === "") {
    throw new HttpError(400, "title must be a non-empty string");
  }
  const trimmed = title.trim();
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new HttpError(400, `title must be at most ${MAX_TITLE_LENGTH} characters`);
  }
  return trimmed;
}

export function validateCreate(body) {
  return { title: normalizeTitle(body.title) };
}

export function validateUpdate(body) {
  const changes = {};
  if ("title" in body) changes.title = normalizeTitle(body.title);
  if ("done" in body) {
    if (typeof body.done !== "boolean") throw new HttpError(400, "done must be a boolean");
    changes.done = body.done;
  }
  return changes;
}

function parseQueryInt(value, name, min, max, fallback) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return Number(value);
}

function readJson(req) {
  return readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
}

function methodNotAllowed(allow) {
  return new HttpError(405, "method not allowed", { allow });
}

async function route(repo, req, res, url, id) {
  if (id === undefined) {
    if (req.method === "GET") {
      const limit = parseQueryInt(url.searchParams.get("limit"), "limit", 1, MAX_TODOS, MAX_TODOS);
      const offset = parseQueryInt(url.searchParams.get("offset"), "offset", 0, Number.MAX_SAFE_INTEGER, 0);
      return send(res, 200, repo.list({ limit, offset }));
    }
    if (req.method === "POST") {
      const input = validateCreate(await readJson(req));
      if (repo.size >= MAX_TODOS) throw new HttpError(409, "todo limit reached");
      return send(res, 201, repo.create(input.title));
    }
    throw methodNotAllowed("GET, POST");
  }

  if (req.method !== "PATCH" && req.method !== "DELETE") throw methodNotAllowed("PATCH, DELETE");
  const numericId = /^\d+$/.test(id) ? Number(id) : NaN;
  if (Number.isNaN(numericId) || !repo.get(numericId)) throw new HttpError(404, "todo not found");

  if (req.method === "PATCH") {
    const changes = validateUpdate(await readJson(req));
    const updated = repo.update(numericId, changes);
    if (!updated) throw new HttpError(404, "todo not found");
    return send(res, 200, updated);
  }
  repo.delete(numericId);
  return send(res, 204);
}

// Returns a handler for /api/todos requests: resolves true when the request was handled.
export function createTodoHandler(repo = new TodoRepository()) {
  return async function handleTodos(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      send(res, 400, { error: "malformed request target" });
      return true;
    }
    const match = /^\/api\/todos(?:\/([^/]+))?\/?$/.exec(url.pathname);
    if (!match) return false;
    try {
      await route(repo, req, res, url, match[1]);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (res.headersSent) return true;
      send(res, err.status, { error: err.message }, err.headers);
      if (err.status === 413) res.once("finish", () => req.destroy());
    }
    return true;
  };
}

export const handleTodos = createTodoHandler();
