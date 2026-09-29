import { randomBytes } from "node:crypto";
import { HttpError, readJson, send } from "./http.js";

export const MAX_BODY_BYTES = 4 * 1024;
export const MAX_POLLS = 500;
export const LIST_LIMIT = 50;
export const MAX_QUESTION_LENGTH = 200;
export const MAX_OPTION_LENGTH = 100;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 8;
export const MIN_DURATION_SEC = 10;
export const MAX_DURATION_SEC = 86400;
export const COOKIE_NAME = "poll_client";

const CLIENT_ID = /^[0-9a-f]{32}$/;

function badRequest(message) {
  return new HttpError(400, message);
}

export function validateCreate(body) {
  const { question, options, durationSec } = body;
  if (typeof question !== "string" || question.trim() === "" || question.trim().length > MAX_QUESTION_LENGTH) {
    throw badRequest(`question must be a string of 1-${MAX_QUESTION_LENGTH} characters`);
  }
  if (!Array.isArray(options) || options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw badRequest(`options must be an array of ${MIN_OPTIONS}-${MAX_OPTIONS} strings`);
  }
  const cleaned = [];
  const seen = new Set();
  for (const option of options) {
    if (typeof option !== "string" || option.trim() === "" || option.trim().length > MAX_OPTION_LENGTH) {
      throw badRequest(`each option must be a string of 1-${MAX_OPTION_LENGTH} characters`);
    }
    const text = option.trim();
    const key = text.toLowerCase();
    if (seen.has(key)) throw badRequest("options must not contain duplicates");
    seen.add(key);
    cleaned.push(text);
  }
  if (
    durationSec !== undefined &&
    (!Number.isInteger(durationSec) || durationSec < MIN_DURATION_SEC || durationSec > MAX_DURATION_SEC)
  ) {
    throw badRequest(`durationSec must be an integer between ${MIN_DURATION_SEC} and ${MAX_DURATION_SEC}`);
  }
  return { question: question.trim(), options: cleaned, durationSec };
}

// In-memory poll store. Keeps the newest MAX_POLLS polls; one vote per client id per poll.
export class PollStore {
  #polls = new Map();
  #now;
  #listeners = new Set();

  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }

  #view(poll) {
    return {
      id: poll.id,
      question: poll.question,
      options: [...poll.options],
      createdAt: poll.createdAt,
      closesAt: poll.closesAt,
      tallies: [...poll.tallies],
      total: poll.total,
    };
  }

  #emit(event) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error("poll listener failed:", err);
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
    while (this.#polls.has(id));
    return id;
  }

  create({ question, options, durationSec }) {
    const now = this.#now();
    const poll = {
      id: this.#newId(),
      question,
      options: [...options],
      createdAt: new Date(now).toISOString(),
      closesAt: durationSec === undefined ? null : new Date(now + durationSec * 1000).toISOString(),
      tallies: options.map(() => 0),
      total: 0,
      votes: new Map(),
    };
    this.#polls.set(poll.id, poll);
    while (this.#polls.size > MAX_POLLS) this.#polls.delete(this.#polls.keys().next().value);
    const view = this.#view(poll);
    this.#emit({ type: "created", poll: view });
    return view;
  }

  // The poll without myVote, or undefined.
  get(id) {
    const poll = this.#polls.get(id);
    return poll ? this.#view(poll) : undefined;
  }

  // Newest first, at most `limit`.
  list(limit = LIST_LIMIT) {
    return [...this.#polls.values()].reverse().slice(0, limit).map((poll) => this.#view(poll));
  }

  myVote(id, clientId) {
    return this.#polls.get(id)?.votes.get(clientId) ?? null;
  }

  // Records or moves the client's vote and returns the poll. Throws HttpError 404 / 409 / 400.
  vote(id, clientId, option) {
    const poll = this.#polls.get(id);
    if (!poll) throw new HttpError(404, "poll not found");
    const now = this.#now();
    if (poll.closesAt !== null && now >= Date.parse(poll.closesAt)) throw new HttpError(409, "poll closed");
    if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) {
      throw badRequest(`option must be an integer between 0 and ${poll.options.length - 1}`);
    }
    const previous = poll.votes.get(clientId) ?? null;
    if (previous !== option) {
      if (previous !== null) poll.tallies[previous] -= 1;
      else poll.total += 1;
      poll.tallies[option] += 1;
      poll.votes.set(clientId, option);
      this.#emit({
        type: "vote",
        pollId: poll.id,
        option,
        previous,
        tallies: [...poll.tallies],
        total: poll.total,
        at: new Date(now).toISOString(),
      });
    }
    return this.#view(poll);
  }
}

export const pollStore = new PollStore();

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

async function route(store, req, res, match, clientId, headers) {
  const [, id, action] = match;
  if (id === undefined) {
    if (req.method === "GET") return send(res, 200, { polls: store.list() }, headers);
    if (req.method === "POST") {
      const input = validateCreate(await readJson(req, { maxBytes: MAX_BODY_BYTES }));
      return send(res, 201, { ...store.create(input), myVote: null }, headers);
    }
    throw methodNotAllowed("GET, POST");
  }
  if (action === undefined) {
    if (req.method !== "GET") throw methodNotAllowed("GET");
    const poll = store.get(id);
    if (!poll) throw new HttpError(404, "poll not found");
    return send(res, 200, { ...poll, myVote: store.myVote(id, clientId) }, headers);
  }
  if (req.method !== "POST") throw methodNotAllowed("POST");
  if (!store.get(id)) throw new HttpError(404, "poll not found");
  const body = await readJson(req, { maxBytes: MAX_BODY_BYTES });
  const poll = store.vote(id, clientId, body.option);
  return send(res, 200, { ...poll, myVote: store.myVote(id, clientId) }, headers);
}

// Returns a handler for /api/polls, /api/polls/<id> and /api/polls/<id>/vote: resolves true when handled.
export function createPollHandler(store = pollStore) {
  return async function handlePolls(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return false;
    }
    const match = /^\/api\/polls(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/.exec(url.pathname);
    if (!match || (match[2] !== undefined && match[2] !== "vote")) return false;
    let clientId = readClientId(req);
    const headers = {};
    if (!clientId) {
      clientId = randomBytes(16).toString("hex");
      headers["set-cookie"] = clientCookie(clientId);
    }
    try {
      await route(store, req, res, match, clientId, headers);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      if (res.headersSent) return true;
      send(res, err.status, { error: err.message }, { ...headers, ...err.headers });
      if (err.status === 413) res.once("finish", () => req.destroy());
    }
    return true;
  };
}

export const handlePolls = createPollHandler();
