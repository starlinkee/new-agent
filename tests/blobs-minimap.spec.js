import { test, expect } from "@playwright/test";

const player = (id, name, x, y, mass) => ({
  id,
  name,
  color: "#3498db",
  x,
  y,
  mass,
  radius: 4 * Math.sqrt(mass),
  bot: false,
  peakMass: mass,
});

async function openMocked(page, { join = true } = {}) {
  const me = player("abcd1234", "me", 1000, 500, 20);
  const heavy = player("aaaa0001", "heavy", 200, 200, 40);
  const light = player("aaaa0002", "light", 1500, 1500, 10);
  const snapshot = { tick: 1, width: 2000, height: 2000, players: [me, heavy, light], food: [[10, 10]] };
  await page.route("**/api/blobs/join", (route) =>
    route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(me) }),
  );
  await page.route("**/api/blobs/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `retry: 100\n\nevent: state\ndata: ${JSON.stringify(snapshot)}\n\n`,
    }),
  );
  await page.goto("/blobs");
  await page.waitForFunction(() => window.__blobs?.state);
  if (!join) return;
  await page.fill("#blobs-name", "me");
  await page.click("#blobs-play");
  await page.waitForFunction(() => window.__blobs.me);
}

const pixel = (page, x, y) =>
  page.evaluate(
    ([px, py]) => {
      const canvas = document.getElementById("blobs-minimap");
      const dpr = canvas.width / 150;
      const d = canvas.getContext("2d").getImageData(Math.round(px * dpr), Math.round(py * dpr), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [x, y],
  );

test("the minimap shows me in white, heavier players in red and lighter ones in grey", async ({ page }) => {
  await openMocked(page);
  await expect(page.locator("#blobs-minimap")).toBeVisible();
  await expect.poll(() => pixel(page, 75, 37)).toEqual([255, 255, 255]);
  expect(await pixel(page, 15, 15)).toEqual([0xe5, 0x39, 0x35]);
  expect(await pixel(page, 112, 112)).toEqual([0x88, 0x88, 0x88]);
});

test("pressing m toggles the minimap but typing m in the name field does not", async ({ page }) => {
  await openMocked(page, { join: false });
  const map = page.locator("#blobs-minimap");
  await page.locator("#blobs-name").focus();
  await page.keyboard.type("m");
  await expect(map).toBeVisible();
  await expect(page.locator("#blobs-name")).toHaveValue("m");
  await page.locator("#blobs-name").blur();
  await page.keyboard.press("m");
  await expect(map).toBeHidden();
  await page.keyboard.press("m");
  await expect(map).toBeVisible();
});
