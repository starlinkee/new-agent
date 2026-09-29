import { test, expect } from "@playwright/test";

// The board is shared server state: paint a pixel and assert that change, never assume a blank board.
async function cellCenter(page, x, y) {
  const box = await page.locator("#pixels").boundingBox();
  return { x: box.x + ((x + 0.5) / 64) * box.width, y: box.y + ((y + 0.5) / 64) * box.height };
}

test.describe("pixels page", () => {
  test("nav link reaches /pixels", async ({ page }) => {
    await page.goto("/");
    await page.click("#pixels-link");
    await expect(page).toHaveURL(/\/pixels$/);
    await expect(page.locator("#pixels")).toBeVisible();
  });

  test("canvas and 16 swatches render, first selected", async ({ page }) => {
    await page.goto("/pixels");
    await expect(page.locator("#palette button")).toHaveCount(16);
    await expect(page.locator("#palette button").first()).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#pixels-tools")).toBeAttached();
    await expect(page.locator("#pixels-status")).toBeAttached();
    await page.waitForFunction(() => window.__pixels?.board);
    expect(await page.evaluate(() => [window.__pixels.board.width, window.__pixels.board.height])).toEqual([64, 64]);
  });

  test("selecting a swatch and clicking a cell paints it", async ({ page, request }) => {
    await page.goto("/pixels");
    await page.waitForFunction(() => window.__pixels?.board);
    const before = await page.evaluate(() => window.__pixels.board.get(10, 12));
    const color = (before + 5) % 16;
    await page.locator("#palette button").nth(color).click();
    await expect(page.locator("#palette button").nth(color)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#palette button[aria-pressed=true]")).toHaveCount(1);
    const pos = await cellCenter(page, 10, 12);
    await page.mouse.click(pos.x, pos.y);
    await expect.poll(() => page.evaluate(() => window.__pixels.board.get(10, 12))).toBe(color);
    await expect
      .poll(async () => (await (await request.get("/api/pixels/at?x=10&y=12")).json()).color)
      .toBe(color);
  });

  test("a rejected paint reverts the pixel and shows a message", async ({ page }) => {
    await page.goto("/pixels");
    await page.waitForFunction(() => window.__pixels?.board);
    await page.route("**/api/pixels", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "nope" }) });
    });
    const before = await page.evaluate(() => window.__pixels.board.get(20, 21));
    const color = (before + 3) % 16;
    await page.locator("#palette button").nth(color).click();
    const pos = await cellCenter(page, 20, 21);
    await page.mouse.click(pos.x, pos.y);
    await expect(page.locator("#pixels-status")).toContainText("nope");
    expect(await page.evaluate(() => window.__pixels.board.get(20, 21))).toBe(before);
  });
});
