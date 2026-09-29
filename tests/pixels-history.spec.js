import { test, expect } from "@playwright/test";

// The board is shared server state: paint pixels and assert those changes, never assume a blank board.
async function paint(request, x, y, color) {
  const res = await request.post("/api/pixels", { data: { x, y, color } });
  expect(res.ok()).toBe(true);
  return res.json();
}

test.describe("pixels history api", () => {
  test("paints appear in order and since filters them", async ({ request }) => {
    const first = await paint(request, 3, 4, 5);
    await new Promise((r) => setTimeout(r, 15));
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 15));
    const second = await paint(request, 6, 7, 8);
    const third = await paint(request, 9, 10, 11);

    const all = await (await request.get("/api/pixels/history")).json();
    expect(typeof all.truncated).toBe("boolean");
    const keys = all.events.map((e) => `${e.x},${e.y},${e.color},${e.updatedAt}`);
    const at = (p) => keys.indexOf(`${p.x},${p.y},${p.color},${p.updatedAt}`);
    expect(at(first)).toBeGreaterThanOrEqual(0);
    expect(at(first)).toBeLessThan(at(second));
    expect(at(second)).toBeLessThan(at(third));

    const filtered = await (await request.get(`/api/pixels/history?since=${encodeURIComponent(since)}`)).json();
    const fkeys = filtered.events.map((e) => `${e.x},${e.y},${e.color},${e.updatedAt}`);
    expect(fkeys).not.toContain(`${first.x},${first.y},${first.color},${first.updatedAt}`);
    expect(fkeys.slice(0, 2)).toEqual([second, third].map((p) => `${p.x},${p.y},${p.color},${p.updatedAt}`));
  });

  test("limit caps the result oldest first", async ({ request }) => {
    const since = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 15));
    const a = await paint(request, 1, 1, 2);
    await paint(request, 2, 2, 3);
    const body = await (await request.get(`/api/pixels/history?since=${encodeURIComponent(since)}&limit=1`)).json();
    expect(body.events).toEqual([a]);
    expect(body.truncated).toBe(true);
  });

  for (const query of ["since=yesterday", "since=", "limit=0", "limit=10001", "limit=abc", "limit=-1", "limit=1.5"]) {
    test(`bad params 400: ${query}`, async ({ request }) => {
      const res = await request.get(`/api/pixels/history?${query}`);
      expect(res.status()).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    });
  }
});

test.describe("pixels replay", () => {
  async function canvasPixels(page) {
    return page.evaluate(() => {
      const c = document.getElementById("pixels");
      return Array.from(c.getContext("2d").getImageData(0, 0, c.width, c.height).data).join(",");
    });
  }

  // RGBA of one canvas pixel, as "r,g,b,a".
  async function canvasPixel(page, x, y) {
    return page.evaluate(([x, y]) => {
      const c = document.getElementById("pixels");
      return Array.from(c.getContext("2d").getImageData(x, y, 1, 1).data).join(",");
    }, [x, y]);
  }

  test("replay starts blank, shows progress and ends with the replayed canvas matching the live board", async ({ page, request }) => {
    // Painted twice so that, until the last event is replayed, (21, 20) never shows its final colour.
    await paint(request, 21, 20, 7);
    await paint(request, 20, 20, 4);
    await paint(request, 21, 20, 4);
    // No live updates: the only thing that can draw on the canvas after loading is the replay itself.
    await page.route("**/api/pixels/stream", (route) => route.abort());
    await page.goto("/pixels");
    await page.waitForFunction(() => window.__pixels?.board);
    const live = await canvasPixels(page);
    const painted = await canvasPixel(page, 21, 20);
    // Change the page's in-memory board only (not the server): redrawing it would differ from `live`,
    // so a final canvas equal to `live` can only come from replaying the server history.
    await page.evaluate(() => {
      const { board } = window.__pixels;
      board.set(22, 20, (board.get(22, 20) + 1) % board.palette.length);
    });

    await page.click("#pixels-replay");
    // Mid-replay the canvas is the history being rebuilt from a blank board, not the live board.
    const mid = await page.waitForFunction(
      ([x, y]) => {
        const text = document.getElementById("pixels-replay-progress").textContent;
        const m = /^(\d+) \/ (\d+)$/.exec(text);
        if (!m || Number(m[1]) >= Number(m[2])) return null;
        const c = document.getElementById("pixels");
        return { text, pixel: Array.from(c.getContext("2d").getImageData(x, y, 1, 1).data).join(",") };
      },
      [21, 20],
    );
    const { pixel } = await mid.jsonValue();
    expect(pixel).not.toBe(painted);

    await expect(page.locator("#pixels-replay-progress")).toHaveText(/^Replayed (\d+) \/ \1$/, { timeout: 10000 });
    expect(await canvasPixel(page, 21, 20)).toBe(painted);
    expect(await canvasPixels(page)).toBe(live);
  });

  test("painting is disabled during replay and Stop restores the live board", async ({ page, playwright, baseURL }) => {
    // 40 paints make the replay long enough to click during it. Paints are rate limited per client
    // (burst of 10), so each batch of 10 comes from a fresh client with its own cookie jar.
    for (let batch = 0; batch < 4; batch++) {
      const client = await playwright.request.newContext({ baseURL });
      for (let i = batch * 10; i < batch * 10 + 10; i++) await paint(client, i, 30, (i % 15) + 1);
      await client.dispose();
    }
    await page.goto("/pixels");
    await page.waitForFunction(() => window.__pixels?.board);
    const live = await canvasPixels(page);
    const before = await page.evaluate(() => window.__pixels.board.get(50, 50));
    const posts = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && new URL(req.url()).pathname === "/api/pixels") posts.push(req.url());
    });
    await page.click("#pixels-replay");
    await expect(page.locator("#pixels-replay-stop")).toBeVisible();
    const box = await page.locator("#pixels").boundingBox();
    await page.mouse.click(box.x + (50.5 / 64) * box.width, box.y + (50.5 / 64) * box.height);
    await page.waitForTimeout(200);
    expect(posts).toEqual([]);
    expect(await page.evaluate(() => window.__pixels.board.get(50, 50))).toBe(before);
    await page.click("#pixels-replay-stop");
    expect(await canvasPixels(page)).toBe(live);
    await expect(page.locator("#pixels-replay-progress")).toHaveText("Stopped");
    await expect(page.locator("#pixels-replay")).toBeEnabled();
  });
});
