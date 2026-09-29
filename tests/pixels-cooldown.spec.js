import { test, expect } from "@playwright/test";

// The board is shared server state: paint a pixel and assert that change, never assume a blank board.
async function cellCenter(page, x, y) {
  const box = await page.locator("#pixels").boundingBox();
  return { x: box.x + ((x + 0.5) / 64) * box.width, y: box.y + ((y + 0.5) / 64) * box.height };
}

test.describe("pixels paint rate limit", () => {
  test("10 quick paints succeed, the 11th is 429 with Retry-After", async ({ playwright, baseURL }) => {
    const client = await playwright.request.newContext({ baseURL });
    const paint = () => client.post("/api/pixels", { data: { x: 40, y: 40, color: 1 } });
    for (let i = 0; i < 10; i++) expect((await paint()).status()).toBe(200);
    const limited = await paint();
    expect(limited.status()).toBe(429);
    expect(Number(limited.headers()["retry-after"])).toBeGreaterThan(0);
    const body = await limited.json();
    expect(body.error).toBeTruthy();
    expect(body.retryAfterMs).toBeGreaterThan(0);
    await client.dispose();
  });

  test("the client cookie is HttpOnly and a different client can still paint", async ({ playwright, baseURL }) => {
    const first = await playwright.request.newContext({ baseURL });
    const res = await first.get("/api/pixels");
    const cookie = res.headers()["set-cookie"];
    expect(cookie).toMatch(/^pixel_client=[0-9a-f]{32}/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    for (let i = 0; i < 10; i++) await first.post("/api/pixels", { data: { x: 41, y: 41, color: 2 } });
    expect((await first.post("/api/pixels", { data: { x: 41, y: 41, color: 2 } })).status()).toBe(429);

    const other = await playwright.request.newContext({ baseURL });
    expect((await other.post("/api/pixels", { data: { x: 42, y: 42, color: 3 } })).status()).toBe(200);
    await first.dispose();
    await other.dispose();
  });

  test("UI shows remaining paints, then a countdown after a 429 and re-enables painting", async ({ page }) => {
    await page.goto("/pixels");
    await page.waitForFunction(() => window.__pixels?.board);
    const before = await page.evaluate(() => window.__pixels.board.get(30, 31));
    const color = (before + 4) % 16;
    await page.locator("#palette button").nth(color).click();
    const pos = await cellCenter(page, 30, 31);
    await page.mouse.click(pos.x, pos.y);
    await expect(page.locator("#pixels-cooldown")).toContainText("Paints left: 9");

    await page.route("**/api/pixels", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 429,
        headers: { "retry-after": "1" },
        contentType: "application/json",
        body: JSON.stringify({ error: "slow down", retryAfterMs: 1500 }),
      });
    });
    const clickCell = async () => {
      const at = await cellCenter(page, 32, 33);
      await page.mouse.click(at.x, at.y);
    };
    await clickCell();
    await expect(page.locator("#pixels-cooldown")).toContainText(/Wait [12]s/);
    await expect(page.locator("#pixels")).toHaveAttribute("aria-disabled", "true");

    await page.unroute("**/api/pixels");
    await clickCell();
    expect(await page.evaluate(() => window.__pixels.board.get(32, 33))).not.toBe(color);

    await expect(page.locator("#pixels")).not.toHaveAttribute("aria-disabled", "true", { timeout: 5000 });
    await expect(page.locator("#pixels-cooldown")).not.toContainText("Wait");
    const next = (color + 1) % 16;
    await page.locator("#palette button").nth(next).click();
    await clickCell();
    await expect.poll(() => page.evaluate(() => window.__pixels.board.get(32, 33))).toBe(next);
  });
});
