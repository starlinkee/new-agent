import http from "node:http";
import { test, expect } from "@playwright/test";
import { createPixelHandler, PixelStore, RateLimiter } from "../src/pixels.js";

const json = { "content-type": "application/json" };

// The board is shared server state: paint a pixel and assert that change, never assume a blank board.
test.describe("pixels API", () => {
  test("GET returns the board shape", async ({ request }) => {
    const res = await request.get("/api/pixels");
    expect(res.status()).toBe(200);
    const board = await res.json();
    expect(board.width).toBe(64);
    expect(board.height).toBe(64);
    expect(board.palette).toHaveLength(16);
    for (const c of board.palette) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(board.pixels).toHaveLength(4096);
    expect(board.pixels).toMatch(/^[0-9a-f]+$/);
  });

  test("paint shows in the board and at()", async ({ request }) => {
    const before = await (await request.get("/api/pixels/at?x=5&y=7")).json();
    const color = (before.color + 1) % 16;
    const res = await request.post("/api/pixels", { data: { x: 5, y: 7, color } });
    expect(res.status()).toBe(200);
    const painted = await res.json();
    expect(painted).toEqual({ x: 5, y: 7, color, updatedAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(painted.updatedAt))).toBe(false);

    const board = await (await request.get("/api/pixels")).json();
    expect(board.pixels[7 * 64 + 5]).toBe(color.toString(16));

    const at = await request.get("/api/pixels/at?x=5&y=7");
    expect(at.status()).toBe(200);
    expect(await at.json()).toEqual(painted);
  });

  test("painting the last pixel with the last colour works", async ({ request }) => {
    const res = await request.post("/api/pixels", { data: { x: 63, y: 63, color: 15 } });
    expect(res.status()).toBe(200);
    const board = await (await request.get("/api/pixels")).json();
    expect(board.pixels[4095]).toBe("f");
  });

  test("at rejects out-of-range and non-integer coordinates", async ({ request }) => {
    for (const q of ["x=64&y=0", "x=0&y=64", "x=-1&y=0", "x=1.5&y=0", "x=a&y=0", "y=0", "x=0"]) {
      const res = await request.get(`/api/pixels/at?${q}`);
      expect(res.status(), q).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
  });

  test("POST rejects bad values with 400", async ({ request }) => {
    const bad = [
      {},
      { x: 64, y: 0, color: 1 },
      { x: 0, y: -1, color: 1 },
      { x: 0, y: 0, color: 16 },
      { x: 0, y: 0, color: -1 },
      { x: 1.5, y: 0, color: 1 },
      { x: "1", y: 0, color: 1 },
      { x: 0, y: 0, color: null },
    ];
    for (const data of bad) {
      const res = await request.post("/api/pixels", { data });
      expect(res.status(), JSON.stringify(data)).toBe(400);
    }
  });

  test("POST rejects malformed JSON and non-object bodies with 400", async ({ request }) => {
    for (const data of ["{not json", "[1,2,3]"]) {
      const res = await request.post("/api/pixels", { headers: json, data });
      expect(res.status()).toBe(400);
    }
  });

  test("POST rejects non-JSON content with 415", async ({ request }) => {
    const res = await request.post("/api/pixels", {
      headers: { "content-type": "text/plain" },
      data: "x=1&y=1&color=1",
    });
    expect(res.status()).toBe(415);
  });

  test("POST rejects oversized bodies with 413", async ({ request }) => {
    const res = await request.post("/api/pixels", {
      headers: json,
      data: JSON.stringify({ x: 0, y: 0, color: 1, pad: "a".repeat(20 * 1024) }),
    });
    expect(res.status()).toBe(413);
  });

  test("wrong methods return 405", async ({ request }) => {
    for (const [method, path] of [
      ["DELETE", "/api/pixels"],
      ["PUT", "/api/pixels"],
      ["POST", "/api/pixels/at?x=0&y=0"],
    ]) {
      const res = await request.fetch(path, { method });
      expect(res.status(), `${method} ${path}`).toBe(405);
      expect(res.headers().allow).toBeTruthy();
    }
  });
});

// Behaviour that needs its own store/limiter runs against a private server built from the same handler,
// so it neither drains the shared server's paint budget nor depends on shared board state.
test.describe("pixels handler (private server)", () => {
  let server;
  let base;
  let store;

  async function start(options) {
    store = new PixelStore();
    const handle = createPixelHandler(store, options);
    server = http.createServer(async (req, res) => {
      try {
        if (!(await handle(req, res))) {
          res.writeHead(404);
          res.end();
        }
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }

  test.afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("paints beyond the per-client burst get 429 with retry-after", async ({ request }) => {
    await start({ limiter: new RateLimiter({ burst: 2, refillPerSecond: 0.1 }) });
    for (let i = 0; i < 2; i++) {
      const ok = await request.post(`${base}/api/pixels`, { data: { x: i, y: 0, color: 4 } });
      expect(ok.status()).toBe(200);
    }
    const limited = await request.post(`${base}/api/pixels`, { data: { x: 2, y: 0, color: 4 } });
    expect(limited.status()).toBe(429);
    expect(Number(limited.headers()["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(typeof (await limited.json()).error).toBe("string");
    // The rejected paint did not change the board.
    const at = await (await request.get(`${base}/api/pixels/at?x=2&y=0`)).json();
    expect(at).toEqual({ x: 2, y: 0, color: 0, updatedAt: null });
    // Invalid requests are rejected before they spend a token.
    const bad = await request.post(`${base}/api/pixels`, { data: { x: 99, y: 0, color: 4 } });
    expect(bad.status()).toBe(400);
  });

  test("the limiter refills over time", async () => {
    let now = 0;
    const limiter = new RateLimiter({ burst: 1, refillPerSecond: 2, now: () => now });
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBeGreaterThan(0);
    expect(limiter.take("b")).toBe(0);
    now += 500;
    expect(limiter.take("a")).toBe(0);
  });

  test("subscribers see each paint; a failing subscriber does not fail the paint", async ({ request }) => {
    await start();
    const seen = [];
    const unsubscribe = store.subscribe((change) => seen.push(change));
    store.subscribe(() => {
      throw new Error("boom");
    });
    const res = await request.post(`${base}/api/pixels`, { data: { x: 3, y: 4, color: 9 } });
    expect(res.status()).toBe(200);
    const painted = await res.json();
    expect(seen).toEqual([painted]);
    const board = await (await request.get(`${base}/api/pixels`)).json();
    expect(board.pixels[4 * 64 + 3]).toBe("9");

    unsubscribe();
    await request.post(`${base}/api/pixels`, { data: { x: 3, y: 4, color: 1 } });
    expect(seen).toHaveLength(1);
  });

  test("HEAD is allowed on the board", async ({ request }) => {
    await start();
    const res = await request.head(`${base}/api/pixels`);
    expect(res.status()).toBe(200);
  });
});
