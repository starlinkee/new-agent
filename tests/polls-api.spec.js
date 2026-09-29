import { test, expect, request as pwRequest } from "@playwright/test";
import { createPollHandler, PollStore } from "../src/polls.js";
import http from "node:http";

const suffix = () => Math.random().toString(36).slice(2, 8);
const newPoll = (over = {}) => ({ question: `Best pet ${suffix()}?`, options: ["Cat", "Dog", "Fish"], ...over });

test.describe("polls API", () => {
  test("create returns 201 with the right shape and appears in the list", async ({ request }) => {
    const body = newPoll({ question: `  Padded ${suffix()}  `, options: [" Cat ", "Dog"] });
    const res = await request.post("/api/polls", { data: body });
    expect(res.status()).toBe(201);
    const poll = await res.json();
    expect(poll.id).toMatch(/^[0-9a-f]{8}$/);
    expect(poll.question).toBe(body.question.trim());
    expect(poll.options).toEqual(["Cat", "Dog"]);
    expect(poll.closesAt).toBeNull();
    expect(new Date(poll.createdAt).toISOString()).toBe(poll.createdAt);
    expect(poll.tallies).toEqual([0, 0]);
    expect(poll.total).toBe(0);
    expect(poll.myVote).toBeNull();

    const list = await (await request.get("/api/polls")).json();
    expect(list.polls.length).toBeLessThanOrEqual(50);
    const listed = list.polls.find((p) => p.id === poll.id);
    expect(listed.question).toBe(poll.question);
    expect("myVote" in listed).toBe(false);
  });

  test("durationSec sets closesAt", async ({ request }) => {
    const poll = await (await request.post("/api/polls", { data: newPoll({ durationSec: 60 }) })).json();
    const delta = Date.parse(poll.closesAt) - Date.parse(poll.createdAt);
    expect(delta).toBe(60000);
  });

  test("GET by id, 404 for unknown id, and the cookie is set", async ({ request }) => {
    const created = await request.post("/api/polls", { data: newPoll() });
    expect(created.headers()["set-cookie"]).toMatch(/^poll_client=[0-9a-f]{32}; .*HttpOnly.*SameSite=Lax/i);
    const poll = await created.json();
    const got = await request.get(`/api/polls/${poll.id}`);
    expect(got.status()).toBe(200);
    expect(await got.json()).toEqual(poll);
    const missing = await request.get("/api/polls/deadbeef");
    expect(missing.status()).toBe(404);
    expect((await missing.json()).error).toBeTruthy();
    expect(missing.headers()["set-cookie"]).toBeUndefined();
  });

  test("two clients voting gives total 2; re-voting moves the vote; myVote per client", async ({ playwright }) => {
    const a = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
    const b = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
    const poll = await (await a.post("/api/polls", { data: newPoll() })).json();
    const vote = (ctx, option) => ctx.post(`/api/polls/${poll.id}/vote`, { data: { option } });

    let res = await vote(a, 0);
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ tallies: [1, 0, 0], total: 1, myVote: 0 });
    res = await vote(b, 1);
    expect(await res.json()).toMatchObject({ tallies: [1, 1, 0], total: 2, myVote: 1 });
    res = await vote(a, 2);
    expect(await res.json()).toMatchObject({ tallies: [0, 1, 1], total: 2, myVote: 2 });
    res = await vote(a, 2);
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ tallies: [0, 1, 1], total: 2, myVote: 2 });

    expect((await (await a.get(`/api/polls/${poll.id}`)).json()).myVote).toBe(2);
    expect((await (await b.get(`/api/polls/${poll.id}`)).json()).myVote).toBe(1);
    const anon = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
    expect((await (await anon.get(`/api/polls/${poll.id}`)).json()).myVote).toBeNull();
    await Promise.all([a.dispose(), b.dispose(), anon.dispose()]);
  });

  test("vote errors: bad option 400, unknown poll 404, wrong method 405", async ({ request }) => {
    const poll = await (await request.post("/api/polls", { data: newPoll() })).json();
    for (const option of [3, -1, 1.5, "1", null]) {
      const res = await request.post(`/api/polls/${poll.id}/vote`, { data: { option } });
      expect(res.status(), JSON.stringify(option)).toBe(400);
    }
    expect((await request.post("/api/polls/deadbeef/vote", { data: { option: 0 } })).status()).toBe(404);
    const res = await request.get(`/api/polls/${poll.id}/vote`);
    expect(res.status()).toBe(405);
    expect(res.headers().allow).toBe("POST");
  });

  test("validation errors", async ({ request }) => {
    const bad = [
      { question: "", options: ["a", "b"] },
      { question: "   ", options: ["a", "b"] },
      { question: 5, options: ["a", "b"] },
      { question: "x".repeat(201), options: ["a", "b"] },
      { question: "q", options: ["only"] },
      { question: "q", options: "ab" },
      { question: "q", options: Array.from({ length: 9 }, (_, i) => `o${i}`) },
      { question: "q", options: ["a", " "] },
      { question: "q", options: ["a", 2] },
      { question: "q", options: ["a", "x".repeat(101)] },
      { question: "q", options: ["Cat", " cat "] },
      { question: "q", options: ["a", "b"], durationSec: 9 },
      { question: "q", options: ["a", "b"], durationSec: 86401 },
      { question: "q", options: ["a", "b"], durationSec: 10.5 },
      { question: "q", options: ["a", "b"], durationSec: "60" },
    ];
    for (const data of bad) {
      const res = await request.post("/api/polls", { data });
      expect(res.status(), JSON.stringify(data)).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    const edge = await request.post("/api/polls", {
      data: { question: "x".repeat(200), options: ["a", "x".repeat(100)], durationSec: 10 },
    });
    expect(edge.status()).toBe(201);
  });

  test("body limits and methods: 413, 415, 400, 405", async ({ request }) => {
    const big = await request.post("/api/polls", { data: newPoll({ question: "q", options: ["a", "b"], pad: "x".repeat(5000) }) });
    expect(big.status()).toBe(413);
    const text = await request.post("/api/polls", { headers: { "content-type": "text/plain" }, data: "hi" });
    expect(text.status()).toBe(415);
    const malformed = await request.post("/api/polls", { headers: { "content-type": "application/json" }, data: "{nope" });
    expect(malformed.status()).toBe(400);
    const method = await request.delete("/api/polls");
    expect(method.status()).toBe(405);
    expect(method.headers().allow).toBe("GET, POST");
    const byId = await request.put("/api/polls/deadbeef");
    expect(byId.status()).toBe(405);
  });

  test("closed poll returns 409 (10 s duration)", async ({ request }) => {
    test.setTimeout(30000);
    const poll = await (await request.post("/api/polls", { data: newPoll({ durationSec: 10 }) })).json();
    expect((await request.post(`/api/polls/${poll.id}/vote`, { data: { option: 0 } })).status()).toBe(200);
    await new Promise((r) => setTimeout(r, 10500));
    const res = await request.post(`/api/polls/${poll.id}/vote`, { data: { option: 1 } });
    expect(res.status()).toBe(409);
    expect(await res.json()).toEqual({ error: "poll closed" });
  });
});

test.describe("poll store and handler with an injected clock", () => {
  let clock;
  let store;
  let server;
  let api;
  test.beforeAll(async () => {
    clock = 1_700_000_000_000;
    store = new PollStore({ now: () => clock });
    const handler = createPollHandler(store);
    server = http.createServer(async (req, res) => {
      if (!(await handler(req, res))) {
        res.writeHead(418).end();
      }
    });
    await new Promise((r) => server.listen(0, r));
    api = await pwRequest.newContext({ baseURL: `http://localhost:${server.address().port}` });
  });
  test.afterAll(async () => {
    await api.dispose();
    await new Promise((r) => server.close(r));
  });

  test("closes at closesAt, notifies subscribers, isolates failing listeners", async () => {
    const events = [];
    store.subscribe(() => {
      throw new Error("boom");
    });
    const off = store.subscribe((e) => events.push(e));
    const poll = await (await api.post("/api/polls", { data: { question: "q", options: ["a", "b"], durationSec: 10 } })).json();
    expect(poll.closesAt).toBe(new Date(clock + 10000).toISOString());
    expect(events[0]).toMatchObject({ type: "created", poll: { id: poll.id } });

    expect((await api.post(`/api/polls/${poll.id}/vote`, { data: { option: 0 } })).status()).toBe(200);
    await api.post(`/api/polls/${poll.id}/vote`, { data: { option: 0 } });
    await api.post(`/api/polls/${poll.id}/vote`, { data: { option: 1 } });
    const votes = events.filter((e) => e.type === "vote");
    expect(votes).toHaveLength(2);
    expect(votes[0]).toMatchObject({ pollId: poll.id, option: 0, previous: null, tallies: [1, 0], total: 1 });
    expect(votes[1]).toMatchObject({ option: 1, previous: 0, tallies: [0, 1], total: 1 });
    expect(new Date(votes[1].at).toISOString()).toBe(votes[1].at);
    expect(store.get(poll.id).tallies).toEqual([0, 1]);
    expect("myVote" in store.get(poll.id)).toBe(false);
    expect(store.get("nope")).toBeUndefined();

    off();
    clock += 10000;
    const res = await api.post(`/api/polls/${poll.id}/vote`, { data: { option: 0 } });
    expect(res.status()).toBe(409);
    expect(await res.json()).toEqual({ error: "poll closed" });
    expect(events.filter((e) => e.type === "vote")).toHaveLength(2);
  });

  test("other /api/polls paths fall through; store keeps at most 500 polls", async () => {
    const poll = store.create({ question: "q", options: ["a", "b"] });
    expect((await api.get(`/api/polls/${poll.id}/events`)).status()).toBe(418);
    expect((await api.get(`/api/polls/${poll.id}/vote/x`)).status()).toBe(418);
    expect((await api.get("/api/pollsx")).status()).toBe(418);
    for (let i = 0; i < 510; i++) store.create({ question: `q${i}`, options: ["a", "b"] });
    expect(store.get(poll.id)).toBeUndefined();
    const list = (await (await api.get("/api/polls")).json()).polls;
    expect(list).toHaveLength(50);
    expect(list[0].question).toBe("q509");
  });
});
