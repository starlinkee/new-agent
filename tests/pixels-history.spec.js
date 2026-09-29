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

  test("replay shows progress and ends matching the live board", async ({ page, request }) => {
    await paint(request, 20, 20, 4);
    await page.goto("/pixels");
    await page.waitForFunction(() => window.__pixels?.board);
    const live = await canvasPixels(page);
    await page.click("#pixels-replay");
    await expect(page.locator("#pixels-replay-progress")).toHaveText(/^\d+ \/ \d+$/);
    await expect(page.locator("#pixels-replay-progress")).toHaveText(/^Replayed (\d+) \/ \1$/, { timeout: 10000 });
    expect(await canvasPixels(page)).toBe(live);
  });

  test("painting is disabled during replay and Stop restores the live board", async ({ page, request }) => {
    for (let i = 0; i < 40; i++) await paint(request, i, 30, (i % 15) + 1);
    await page.goto("/pixels");
    await page.waitForFunction(() => window.__pixels?.board);
    const live = await canvasPixels(page);
    const before = await page.evaluate(() => window.__pixels.board.get(50, 50));
    await page.click("#pixels-replay");
    await expect(page.locator("#pixels-replay-stop")).toBeVisible();
    const box = await page.locator("#pixels").boundingBox();
    await page.mouse.click(box.x + (50.5 / 64) * box.width, box.y + (50.5 / 64) * box.height);
    expect(await page.evaluate(() => window.__pixels.board.get(50, 50))).toBe(before);
    await page.click("#pixels-replay-stop");
    expect(await canvasPixels(page)).toBe(live);
    await expect(page.locator("#pixels-replay-progress")).toHaveText("Stopped");
    await expect(page.locator("#pixels-replay")).toBeEnabled();
  });
});
