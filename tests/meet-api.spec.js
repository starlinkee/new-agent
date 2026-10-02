import { test, expect } from "@playwright/test";
import { MeetStore, zonedToUtc } from "../src/meet.js";

const suffix = () => Math.random().toString(36).slice(2, 8);
const newEvent = (over = {}) => ({
  title: `Standup ${suffix()}`,
  dates: ["2030-07-02", "2030-07-01"],
  startMinute: 540,
  endMinute: 660,
  timezone: "Europe/Warsaw",
  ...over,
});
const storeInput = (over = {}) => ({ ...newEvent(), dates: ["2030-07-01", "2030-07-02"], ...over });

test.describe("meet API", () => {
  test("create returns the event with timezone-aware slots and a cookie", async ({ request }) => {
    const res = await request.post("/api/meet", { data: newEvent({ title: `  Padded ${suffix()}  ` }) });
    expect(res.status()).toBe(201);
    expect(res.headers()["set-cookie"]).toMatch(/^meet_client=[0-9a-f]{32}; Path=\/; Max-Age=31536000; HttpOnly; SameSite=Lax$/);
    const event = await res.json();
    expect(event.id).toMatch(/^[0-9a-f]{8}$/);
    expect(event.title).toBe(event.title.trim());
    expect(event.dates).toEqual(["2030-07-01", "2030-07-02"]);
    expect(event.slotMinutes).toBe(30);
    expect(event.slotsPerDay).toBe(4);
    expect(event.slots).toHaveLength(8);
    expect(event.slots[0]).toEqual({ index: 0, date: "2030-07-01", time: "09:00", start: "2030-07-01T07:00:00.000Z" });
    expect(event.slots[7]).toMatchObject({ index: 7, date: "2030-07-02", time: "10:30" });
    expect(event.counts).toEqual(Array(8).fill(0));
    expect(event.participants).toEqual([]);
    expect(event.me).toBeNull();
    expect(new Date(event.createdAt).toISOString()).toBe(event.createdAt);
  });

  test("omitted timezone defaults to UTC", async ({ request }) => {
    const { timezone, ...body } = newEvent();
    const event = await (await request.post("/api/meet", { data: body })).json();
    expect(event.timezone).toBe("UTC");
    expect(event.slots[0].start).toBe("2030-07-01T09:00:00.000Z");
  });

  test("invalid create input is rejected with 400 naming the field", async ({ request }) => {
    const cases = [
      [{ title: "   " }, "title"],
      [{ title: "x".repeat(101) }, "title"],
      [{ dates: [] }, "dates"],
      [{ dates: Array.from({ length: 15 }, (_, i) => `2030-08-${String(i + 1).padStart(2, "0")}`) }, "dates"],
      [{ dates: ["2030-07-01", "2030-07-01"] }, "dates"],
      [{ dates: ["2030-02-30"] }, "dates"],
      [{ startMinute: 45 }, "startMinute"],
      [{ startMinute: 660, endMinute: 660 }, "endMinute"],
      [{ endMinute: 1470 }, "endMinute"],
      [{ timezone: "Mars/Base" }, "timezone"],
    ];
    for (const [over, field] of cases) {
      const res = await request.post("/api/meet", { data: newEvent(over) });
      expect(res.status(), JSON.stringify(over)).toBe(400);
      expect((await res.json()).error).toContain(field);
    }
  });

  test("GET /api/meet is 405 and unknown ids are 404", async ({ request }) => {
    const list = await request.get("/api/meet");
    expect(list.status()).toBe(405);
    expect(list.headers().allow).toBe("POST");
    const missing = await request.get("/api/meet/deadbeef");
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual({ error: "event not found" });
    expect((await request.put("/api/meet/deadbeef/availability", { data: { name: "A", slots: [] } })).status()).toBe(404);
    expect((await request.delete("/api/meet/deadbeef/availability")).status()).toBe(404);
  });

  test("availability: save and replace keep one participant", async ({ request }) => {
    const event = await (await request.post("/api/meet", { data: newEvent() })).json();
    const url = `/api/meet/${event.id}/availability`;

    const first = await request.put(url, { data: { name: "  Ann ", slots: [3, 1] } });
    expect(first.status()).toBe(200);
    const saved = await first.json();
    expect(saved.participants).toHaveLength(1);
    expect(saved.participants[0]).toMatchObject({ name: "Ann", slots: [1, 3] });
    expect(saved.me).toBe(saved.participants[0].id);
    expect(saved.counts).toEqual([0, 1, 0, 1, 0, 0, 0, 0]);
    expect(saved.me).not.toMatch(/^meet_client/);

    const again = await (await request.put(url, { data: { name: "Ann B", slots: [1, 2] } })).json();
    expect(again.participants).toHaveLength(1);
    expect(again.me).toBe(saved.me);
    expect(again.participants[0]).toMatchObject({ id: saved.me, name: "Ann B", slots: [1, 2] });
    expect(again.counts).toEqual([0, 1, 1, 0, 0, 0, 0, 0]);

  });

  test("two clients overlap and withdraw independently", async ({ request, playwright, baseURL }) => {
    const event = await (await request.post("/api/meet", { data: newEvent() })).json();
    const url = `/api/meet/${event.id}/availability`;
    const second = await playwright.request.newContext({ baseURL });
    try {
      const a = await (await request.put(url, { data: { name: "Ann", slots: [0, 1] } })).json();
      const b = await (await second.put(url, { data: { name: "Bob", slots: [1, 2] } })).json();
      expect(b.participants.map((p) => p.name)).toEqual(["Ann", "Bob"]);
      expect(b.me).not.toBe(a.me);
      expect(b.counts).toEqual([1, 2, 1, 0, 0, 0, 0, 0]);

      const view = await (await request.get(`/api/meet/${event.id}`)).json();
      expect(view.me).toBe(a.me);

      expect((await request.delete(url)).status()).toBe(204);
      expect((await request.delete(url)).status()).toBe(204);
      const after = await (await second.get(`/api/meet/${event.id}`)).json();
      expect(after.participants.map((p) => p.name)).toEqual(["Bob"]);
      expect(after.counts).toEqual([0, 1, 1, 0, 0, 0, 0, 0]);
      expect(after.me).toBe(b.me);
    } finally {
      await second.dispose();
    }
  });

  test("invalid availability is rejected", async ({ request }) => {
    const event = await (await request.post("/api/meet", { data: newEvent() })).json();
    const url = `/api/meet/${event.id}/availability`;
    const bad = [
      { name: "A", slots: [8] },
      { name: "A", slots: [-1] },
      { name: "A", slots: [1, 1] },
      { name: "A", slots: [1.5] },
      { name: "A", slots: "1" },
      { name: "A" },
      { name: "  ", slots: [] },
      { name: "x".repeat(41), slots: [] },
    ];
    for (const data of bad) expect((await request.put(url, { data })).status(), JSON.stringify(data)).toBe(400);
    expect((await request.put(url, { data: { name: "A", slots: [] } })).status()).toBe(200);
  });

  test("oversized bodies are 413 and wrong methods 405", async ({ request }) => {
    const event = await (await request.post("/api/meet", { data: newEvent() })).json();
    const big = await request.post("/api/meet", { data: newEvent({ title: "x".repeat(9000) }) });
    expect(big.status()).toBe(413);
    const bigPut = await request.put(`/api/meet/${event.id}/availability`, { data: { name: "A", slots: [], pad: "x".repeat(9000) } });
    expect(bigPut.status()).toBe(413);
    const post = await request.post(`/api/meet/${event.id}`, { data: {} });
    expect(post.status()).toBe(405);
    expect(post.headers().allow).toBe("GET");
    const get = await request.get(`/api/meet/${event.id}/availability`);
    expect(get.status()).toBe(405);
    expect(get.headers().allow).toBe("PUT, DELETE");
  });

  test("other /api/meet/<id>/<name> paths are not handled", async ({ request }) => {
    const event = await (await request.post("/api/meet", { data: newEvent() })).json();
    const res = await request.get(`/api/meet/${event.id}/nope`);
    expect(res.status()).toBe(404);
  });
});

test.describe("MeetStore", () => {
  test("respond past MAX_PARTICIPANTS is 409 for new clients only", () => {
    const store = new MeetStore();
    const event = store.create(storeInput());
    for (let i = 0; i < 50; i += 1) store.respond(event.id, `c${i}`, { name: `P${i}`, slots: [] });
    expect(() => store.respond(event.id, "extra", { name: "X", slots: [] })).toThrowError(
      expect.objectContaining({ status: 409, message: "event is full" }),
    );
    expect(store.respond(event.id, "c0", { name: "Renamed", slots: [0] }).participants).toHaveLength(50);
  });

  test("respond and withdraw errors", () => {
    const store = new MeetStore();
    expect(() => store.respond("nope", "c", { name: "A", slots: [] })).toThrowError(expect.objectContaining({ status: 404 }));
    expect(() => store.withdraw("nope", "c")).toThrowError(expect.objectContaining({ status: 404 }));
    const event = store.create(storeInput());
    expect(store.withdraw(event.id, "c")).toBe(false);
    expect(store.participantOf(event.id, "c")).toBeNull();
    expect(store.get("nope")).toBeUndefined();
  });

  test("subscribe delivers created, responded and withdrawn events", () => {
    const store = new MeetStore({ now: () => Date.parse("2030-01-01T00:00:00Z") });
    const seen = [];
    const unsubscribe = store.subscribe((e) => seen.push(e));
    const event = store.create(storeInput());
    store.respond(event.id, "c1", { name: "Ann", slots: [2] });
    expect(store.withdraw(event.id, "c2")).toBe(false);
    expect(store.withdraw(event.id, "c1")).toBe(true);
    expect(seen.map((e) => e.type)).toEqual(["created", "responded", "withdrawn"]);
    expect(seen.every((e) => e.at === "2030-01-01T00:00:00.000Z")).toBe(true);
    expect(seen[0].event.id).toBe(event.id);
    expect(seen[1]).toMatchObject({ eventId: event.id, participant: { name: "Ann", slots: [2] } });
    expect(seen[1].event.counts[2]).toBe(1);
    expect(seen[2]).toMatchObject({ eventId: event.id, participantId: seen[1].participant.id });
    expect(seen[2].event.counts[2]).toBe(0);
    unsubscribe();
    store.create(storeInput());
    expect(seen).toHaveLength(3);
  });

  test("a throwing listener does not stop the others", () => {
    const store = new MeetStore();
    const seen = [];
    const originalError = console.error;
    console.error = () => {};
    try {
      store.subscribe(() => {
        throw new Error("boom");
      });
      store.subscribe((e) => seen.push(e.type));
      store.create(storeInput());
    } finally {
      console.error = originalError;
    }
    expect(seen).toEqual(["created"]);
  });

  test("evicts the oldest event past MAX_EVENTS", () => {
    const store = new MeetStore();
    const first = store.create(storeInput());
    for (let i = 0; i < 500; i += 1) store.create(storeInput());
    expect(store.get(first.id)).toBeUndefined();
  });
});

test.describe("zonedToUtc", () => {
  test("ordinary, DST gap and DST overlap times", () => {
    expect(zonedToUtc("2026-07-01", 540, "Europe/Warsaw").toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(zonedToUtc("2026-01-15", 540, "Europe/Warsaw").toISOString()).toBe("2026-01-15T08:00:00.000Z");
    expect(zonedToUtc("2027-03-28", 150, "Europe/Warsaw").toISOString()).toBe("2027-03-28T01:30:00.000Z");
    expect(zonedToUtc("2026-10-25", 150, "Europe/Warsaw").toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(zonedToUtc("2030-01-15", 0, "America/New_York").toISOString()).toBe("2030-01-15T05:00:00.000Z");
  });
});
