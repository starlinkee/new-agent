import { test, expect } from "@playwright/test";

// The board is shared server state: paint a pixel and assert that change, never assume a blank board.
async function open(page) {
  await page.goto("/pixels");
  await page.waitForFunction(() => window.__pixels?.board);
}

async function canvasBox(page) {
  return page.locator("#pixels").boundingBox();
}

async function frameBox(page) {
  return page.locator(".pixels-viewport").boundingBox();
}

// Client point of the middle of board cell (x, y) under the current view.
async function cellCenter(page, x, y) {
  return page.evaluate(
    async ([cx, cy]) => {
      const math = await import("/static/pixels/viewport-math.js");
      const frame = document.querySelector(".pixels-viewport").getBoundingClientRect();
      const inner = document.getElementById("pixels").offsetWidth;
      const p = math.boardToScreen(window.__pixels.view, inner, 64, cx + 0.5, cy + 0.5);
      return { x: frame.left + 1 + p.x, y: frame.top + 1 + p.y };
    },
    [x, y],
  );
}

async function zoomIn(page, steps) {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < steps; i++) await page.mouse.wheel(0, -100);
}

test.describe("pixels viewport", () => {
  test("viewport-math round-trips and clamps", async ({ page }) => {
    await open(page);
    const result = await page.evaluate(async () => {
      const m = await import("/static/pixels/viewport-math.js");
      const view = m.zoomAt(m.createView(), 640, 4, 100, 200);
      const b = m.screenToBoard(view, 640, 64, 123, 321);
      const s = m.boardToScreen(view, 640, 64, b.x, b.y);
      const anchorBefore = m.screenToBoard(m.createView(), 640, 64, 100, 200);
      const anchorAfter = m.screenToBoard(view, 640, 64, 100, 200);
      return {
        scale: view.scale,
        s,
        anchorBefore,
        anchorAfter,
        maxed: m.zoomAt(view, 640, 1000, 0, 0).scale,
        floor: m.zoomAt(view, 640, 0.0001, 0, 0).scale,
        panned: m.panBy(view, 640, 100000, 100000),
        cell: m.cellAt(m.createView(), 640, 64, 65, 5),
      };
    });
    expect(result.scale).toBe(4);
    expect(result.s.x).toBeCloseTo(123, 6);
    expect(result.s.y).toBeCloseTo(321, 6);
    expect(result.anchorAfter.x).toBeCloseTo(result.anchorBefore.x, 6);
    expect(result.anchorAfter.y).toBeCloseTo(result.anchorBefore.y, 6);
    expect(result.maxed).toBe(16);
    expect(result.floor).toBe(1);
    expect(result.panned.x).toBe(0);
    expect(result.panned.y).toBe(0);
    expect(result.cell).toEqual({ x: 6, y: 0 });
  });

  test("wheel zooms in and clicking a cell paints the expected coordinate", async ({ page, request }) => {
    await open(page);
    await zoomIn(page, 6);
    const scale = await page.evaluate(() => window.__pixels.view.scale);
    expect(scale).toBeGreaterThan(2);
    const target = await page.evaluate(async () => {
      const { screenToBoard } = await import("/static/pixels/viewport-math.js");
      const v = window.__pixels.view;
      const inner = document.getElementById("pixels").offsetWidth;
      const c = screenToBoard(v, inner, 64, inner / 2, inner / 2);
      return { x: Math.floor(c.x), y: Math.floor(c.y) };
    });
    const before = await page.evaluate(([x, y]) => window.__pixels.board.get(x, y), [target.x, target.y]);
    const color = (before + 7) % 16;
    await page.locator("#palette button").nth(color).click();
    const pos = await cellCenter(page, target.x, target.y);
    await page.mouse.click(pos.x, pos.y);
    await expect.poll(() => page.evaluate(([x, y]) => window.__pixels.board.get(x, y), [target.x, target.y])).toBe(color);
    await expect
      .poll(async () => (await (await request.get(`/api/pixels/at?x=${target.x}&y=${target.y}`)).json()).color)
      .toBe(color);
  });

  test("dragging pans and never paints", async ({ page }) => {
    await open(page);
    await zoomIn(page, 6);
    let posts = 0;
    await page.route("**/api/pixels", (route) => {
      if (route.request().method() === "POST") posts++;
      return route.continue();
    });
    const startView = await page.evaluate(() => ({ ...window.__pixels.view }));
    const box = await frameBox(page);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 40, cy + 30, { steps: 5 });
    await page.mouse.up();
    const endView = await page.evaluate(() => ({ ...window.__pixels.view }));
    expect(endView.x).toBeGreaterThan(startView.x);
    expect(endView.y).toBeGreaterThan(startView.y);
    await page.waitForTimeout(200);
    expect(posts).toBe(0);
    await expect(page.locator("#pixels-status")).not.toContainText("Painted");
  });

  test("hover shows coordinates, then the paint time or never", async ({ page, request }) => {
    await open(page);
    const painted = await request.post("/api/pixels", { data: { x: 30, y: 31, color: 3 } });
    expect(painted.ok()).toBe(true);
    const pos = await cellCenter(page, 30, 31);
    await page.mouse.move(pos.x, pos.y);
    await expect(page.locator("#pixels-coords")).toHaveText(/^30, 31/);
    await expect(page.locator("#pixels-coords")).toContainText("·");
    await expect(page.locator("#pixels-coords")).not.toContainText("never");

    await page.route("**/api/pixels/at?*", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ x: 5, y: 6, color: 0, updatedAt: null }) }),
    );
    const other = await cellCenter(page, 5, 6);
    await page.mouse.move(other.x, other.y);
    await expect(page.locator("#pixels-coords")).toHaveText("5, 6");
    await expect(page.locator("#pixels-coords")).toHaveText("5, 6 · never");
  });

  test("Reset view restores scale 1", async ({ page }) => {
    await open(page);
    await zoomIn(page, 6);
    expect(await page.evaluate(() => window.__pixels.view.scale)).toBeGreaterThan(1);
    await page.click("#pixels-reset-view");
    expect(await page.evaluate(() => ({ ...window.__pixels.view }))).toEqual({ scale: 1, x: 0, y: 0 });
  });
});
