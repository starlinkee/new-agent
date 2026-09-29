import { test, expect } from "@playwright/test";

// The board is shared server state: paint a pixel and assert that change, never assume a blank board.
async function open(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/pixels");
  await page.waitForFunction(() => window.__pixels?.board);
  await expect(page.locator("#pixels-live")).toHaveText("live");
  return { context, page };
}

const colorAt = (page, x, y) => page.evaluate(([x, y]) => window.__pixels.board.get(x, y), [x, y]);

test.describe("pixels live updates", () => {
  test("a pixel painted in one page appears in another without reload", async ({ browser }) => {
    const a = await open(browser);
    const b = await open(browser);
    const before = await colorAt(b.page, 20, 21);
    const color = (before + 3) % 16;
    await a.page.locator("#palette button").nth(color).click();
    const box = await a.page.locator("#pixels").boundingBox();
    await a.page.mouse.click(box.x + (20.5 / 64) * box.width, box.y + (21.5 / 64) * box.height);
    await expect.poll(() => colorAt(b.page, 20, 21)).toBe(color);
    await a.context.close();
    await b.context.close();
  });

  test("a pixel painted through the API appears and the indicator shows live", async ({ browser, request }) => {
    const { context, page } = await open(browser);
    const before = await colorAt(page, 30, 31);
    const color = (before + 7) % 16;
    const res = await request.post("/api/pixels", { data: { x: 30, y: 31, color } });
    expect(res.status()).toBe(200);
    await expect.poll(() => colorAt(page, 30, 31)).toBe(color);
    await expect(page.locator("#pixels-live")).toHaveText("live");
    await context.close();
  });

  test("the stream is text/event-stream and sends pixel events", async ({ page, request }) => {
    await page.goto("/pixels");
    const received = await page.evaluate(
      (color) =>
        new Promise((resolve, reject) => {
          const source = new EventSource("/api/pixels/stream");
          source.addEventListener("pixel", (e) => {
            const p = JSON.parse(e.data);
            if (p.x === 40 && p.y === 41 && p.color === color) {
              source.close();
              resolve(p);
            }
          });
          source.addEventListener("open", () =>
            fetch("/api/pixels", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ x: 40, y: 41, color }),
            }).catch(reject),
          );
        }),
      9,
    );
    expect(received).toEqual({ x: 40, y: 41, color: 9, updatedAt: expect.any(String) });
    const res = await request.fetch("/api/pixels/stream", { method: "POST" });
    expect(res.status()).toBe(405);
  });
});
