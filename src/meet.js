import { randomBytes } from "node:crypto";
import { HttpError, readJson, send } from "./http.js";

export const COOKIE_NAME = "meet_client";
export const SLOT_MINUTES = 30;
export const MAX_EVENTS = 500;
export const MAX_DATES = 14;
export const MAX_TITLE_LENGTH = 100;
export const MAX_NAME_LENGTH = 40;
export const MAX_PARTICIPANTS = 50;
export const MAX_BODY_BYTES = 8 * 1024;

const CLIENT_ID = /^[0-9a-f]{32}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

function badRequest(message) {
  return new HttpError(400, message);
}

function methodNotAllowed(allow) {
  return new HttpError(405, "method not allowed", { allow });
}

function parseDate(value) {
  const match = typeof value === "string" ? DATE.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return ms;
}

const formatters = new Map();

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// Offset of the zone from UTC (ms, local minus UTC) in effect at the given instant.
function offsetAt(instantMs, timeZone) {
  const parts = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(new Date(instantMs))) parts[type] = Number(value);
  const local = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return local - Math.floor(instantMs / 1000) * 1000;
}

// The UTC instant at which the wall clock in `timeZone` shows `date` ("YYYY-MM-DD") at `minuteOfDay`.
// A skipped local time uses the offset in effect before the change; a repeated one the earlier instant.
export function zonedToUtc(date, minuteOfDay, timeZone) {
  const wall = parseDate(date) + minuteOfDay * 60000;
  const before = offsetAt(wall - DAY_MS, timeZone);
  const after = offsetAt(wall + DAY_MS, timeZone);
  const valid = [before, after]
    .map((offset) => wall - offset)
    .filter((utc) => offsetAt(utc, timeZone) === wall - utc);
  if (valid.length === 0) return new Date(wall - before);
  return new Date(Math.min(...valid));
}

function isValidTimeZone(timeZone) {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function formatTime(minuteOfDay) {
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const mm = String(minuteOfDay % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function validateCreate(body) {
  const { title, dates, startMinute, endMinute, timezone } = body;
  if (typeof title !== "string" || title.trim() === "" || title.trim().length > MAX_TITLE_LENGTH) {
    throw badRequest(`title must be a string of 1-${MAX_TITLE_LENGTH} characters`);
  }
  if (!Array.isArray(dates) || dates.length < 1 || dates.length > MAX_DATES) {
    throw badRequest(`dates must be an array of 1-${MAX_DATES} dates`);
  }
  const seen = new Set();
  for (const date of dates) {
    if (parseDate(date) === null) throw badRequest("dates must contain real calendar dates formatted YYYY-MM-DD");
    if (seen.has(date)) throw badRequest("dates must not contain duplicates");
    seen.add(date);
  }
  const isSlotBoundary = (n) => Number.isInteger(n) && n % SLOT_MINUTES === 0;
  if (!isSlotBoundary(startMinute) || startMinute < 0 || startMinute >= 1440) {
    throw badRequest(`startMinute must be a multiple of ${SLOT_MINUTES} between 0 and 1410`);
  }
  if (!isSlotBoundary(endMinute) || endMinute > 1440 || endMinute <= startMinute) {
    throw badRequest(`endMinute must be a multiple of ${SLOT_MINUTES} after startMinute and at most 1440`);
  }
  if (timezone !== undefined && (typeof timezone !== "string" || !isValidTimeZone(timezone))) {
    throw badRequest("timezone must be an IANA time zone name");
  }
  return {
    title: title.trim(),
    dates: [...dates].sort(),
    startMinute,
    endMinute,
    timezone: timezone ?? "UTC",
  };
}

function validateResponse({ name, slots }, slotCount) {
  if (typeof name !== "string" || name.trim() === "" || name.trim().length > MAX_NAME_LENGTH) {
    throw badRequest(`name must be a string of 1-${MAX_NAME_LENGTH} characters`);
  }
  if (!Array.isArray(slots)) throw badRequest("slots must be an array of slot indexes");
  const seen = new Set();
  for (const slot of slots) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= slotCount) {
      throw badRequest(`slots must be integers between 0 and ${slotCount - 1}`);
    }
    if (seen.has(slot)) throw badRequest("slots must not contain duplicates");
    seen.add(slot);
  }
  return { name: name.trim(), slots: [...seen].sort((a, b) => a - b) };
}

// In-memory event store. Keeps the newest MAX_EVENTS events; one response per client id per event.
export class MeetStore {
  #events = new Map();
  #now;
  #listeners = new Set();

  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }

  #participantView(participant) {
    return { id: participant.id, name: participant.name, slots: [...participant.slots], updatedAt: participant.updatedAt };
  }

  #view(event) {
    const counts = event.slots.map(() => 0);
    const participants = [];
    for (const participant of event.responses.values()) {
      participants.push(this.#participantView(participant));
      for (const slot of participant.slots) counts[slot] += 1;
    }
    return {
      id: event.id,
      title: event.title,
      timezone: event.timezone,
      dates: [...event.dates],
      startMinute: event.startMinute,
      endMinute: event.endMinute,
      slotMinutes: SLOT_MINUTES,
      slotsPerDay: event.slotsPerDay,
      slots: event.slots.map((slot) => ({ ...slot })),
      participants,
      counts,
      createdAt: event.createdAt,
    };
  }

  #emit(event) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.error("meet listener failed:", err);
      }
    }
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #newId(taken) {
    let id;
    do id = randomBytes(4).toString("hex");
    while (taken(id));
    return id;
  }

  #find(id) {
    const event = this.#events.get(id);
    if (!event) throw new HttpError(404, "event not found");
    return event;
  }

  create({ title, dates, startMinute, endMinute, timezone }) {
    const now = this.#now();
    const slotsPerDay = (endMinute - startMinute) / SLOT_MINUTES;
    const sorted = [...dates].sort();
    const slots = [];
    sorted.forEach((date, d) => {
      for (let k = 0; k < slotsPerDay; k += 1) {
        const minute = startMinute + k * SLOT_MINUTES;
        slots.push({
          index: d * slotsPerDay + k,
          date,
          time: formatTime(minute),
          start: zonedToUtc(date, minute, timezone).toISOString(),
        });
      }
    });
    const event = {
      id: this.#newId((id) => this.#events.has(id)),
      title,
      timezone,
      dates: sorted,
      startMinute,
      endMinute,
      slotsPerDay,
      slots,
      createdAt: new Date(now).toISOString(),
      responses: new Map(),
    };
    this.#events.set(event.id, event);
    while (this.#events.size > MAX_EVENTS) this.#events.delete(this.#events.keys().next().value);
    const view = this.#view(event);
    this.#emit({ type: "created", event: view, at: event.createdAt });
    return view;
  }

  get(id) {
    const event = this.#events.get(id);
    return event ? this.#view(event) : undefined;
  }

  participantOf(id, clientId) {
    return this.#events.get(id)?.responses.get(clientId)?.id ?? null;
  }

  respond(id, clientId, input) {
    const event = this.#find(id);
    const { name, slots } = validateResponse(input ?? {}, event.slots.length);
    const existing = event.responses.get(clientId);
    if (!existing && event.responses.size >= MAX_PARTICIPANTS) throw new HttpError(409, "event is full");
    const at = new Date(this.#now()).toISOString();
    const participant = existing ?? {
      id: this.#newId((pid) => [...event.responses.values()].some((p) => p.id === pid)),
    };
    participant.name = name;
    participant.slots = slots;
    participant.updatedAt = at;
    event.responses.set(clientId, participant);
    const view = this.#view(event);
    this.#emit({ type: "responded", eventId: event.id, participant: this.#participantView(participant), event: view, at });
    return view;
  }

  withdraw(id, clientId) {
    const event = this.#find(id);
    const participant = event.responses.get(clientId);
    if (!participant) return false;
    event.responses.delete(clientId);
    this.#emit({
      type: "withdrawn",
      eventId: event.id,
      participantId: participant.id,
      event: this.#view(event),
      at: new Date(this.#now()).toISOString(),
    });
    return true;
  }
}

export const meetStore = new MeetStore();

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

async function route(store, req, res, match, clientId, headers) {
  const [, id, action] = match;
  if (id === undefined) {
    if (req.method !== "POST") throw methodNotAllowed("POST");
    const input = validateCreate(await readJson(req, { maxBytes: MAX_BODY_BYTES }));
    return send(res, 201, { ...store.create(input), me: null }, headers);
  }
  if (action === undefined) {
    if (req.method !== "GET") throw methodNotAllowed("GET");
    const event = store.get(id);
    if (!event) throw new HttpError(404, "event not found");
    return send(res, 200, { ...event, me: store.participantOf(id, clientId) }, headers);
  }
  if (req.method === "PUT") {
    if (!store.get(id)) throw new HttpError(404, "event not found");
    const body = await readJson(req, { maxBytes: MAX_BODY_BYTES });
    const event = store.respond(id, clientId, { name: body.name, slots: body.slots });
    return send(res, 200, { ...event, me: store.participantOf(id, clientId) }, headers);
  }
  if (req.method === "DELETE") {
    store.withdraw(id, clientId);
    return send(res, 204, undefined, headers);
  }
  throw methodNotAllowed("PUT, DELETE");
}

// Returns a handler for /api/meet, /api/meet/<id> and /api/meet/<id>/availability: resolves true when handled.
export function createMeetHandler(store = meetStore) {
  return async function handleMeet(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return false;
    }
    const match = /^\/api\/meet(?:\/([^/]+)(?:\/([^/]+))?)?\/?$/.exec(url.pathname);
    if (!match || (match[2] !== undefined && match[2] !== "availability")) return false;
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

export const handleMeet = createMeetHandler();
