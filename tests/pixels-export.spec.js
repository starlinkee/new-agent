import fs from "node:fs";
import { test, expect } from "@playwright/test";

const NAME = /^pixels-\d{8}-\d{6}\.png$/;

// The board is shared server state: paint a pixel and assert that change, never assume a blank board.
test.describe("pixels export", () => {
  test("Export downloads a 512x512 PNG whose cells match the palette", async ({ page, request }) => {
    const board = await (await request.get("/api/pixels")).json();
    const x = 7;
    const y = 9;
    const before = parseInt(board.pixels[y * board.width + x], 16);
    const color = (before + 3) % board.palette.length;
    expect((await request.post("/api/pixels", { data: { x, y, color } })).status()).toBe(200);

    await page.goto("/pixels");
    await page.waitForFunction(() => window.__pixels?.board);
    await expect.poll(() => page.evaluate(([cx, cy]) => window.__pixels.board.get(cx, cy), [x, y])).toBe(color);

    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#pixels-export")]);
    expect(download.suggestedFilename()).toMatch(NAME);

    const bytes = fs.readFileSync(await download.path());
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(bytes.readUInt32BE(16)).toBe(512);
    expect(bytes.readUInt32BE(20)).toBe(512);

    const sampled = await page.evaluate(
      async ({ b64, px, py }) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bitmap = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = bitmap.width;
        c.height = bitmap.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        const [r, g, bl] = ctx.getImageData(px, py, 1, 1).data;
        return "#" + [r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("");
      },
      { b64: bytes.toString("base64"), px: x * 8 + 4, py: y * 8 + 4 },
    );
    expect(sampled).toBe(board.palette[color].toLowerCase());
  });

  test("filename helper formats local time as YYYYMMDD-HHmmss", async ({ page }) => {
    await page.goto("/pixels");
    const name = await page.evaluate(async () => {
      const { exportFilename } = await import("/static/pixels/plugins/export.js");
      return exportFilename(new Date(2026, 0, 2, 3, 4, 5));
    });
    expect(name).toBe("pixels-20260102-030405.png");
  });
});
