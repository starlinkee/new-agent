import { test, expect } from "@playwright/test";

const uniqueName = () => `lb${Math.random().toString(36).slice(2, 8)}`;

const player = (i, mass, extra = {}) => ({
  id: i.toString(16).padStart(8, "0"),
  name: `p${i}`,
  color: "#3498db",
  x: 100 + i * 10,
  y: 100,
  mass,
  radius: 4 * Math.sqrt(mass),
  bot: false,
  peakMass: mass,
  ...extra,
});

const snapshot = (players) => ({ tick: 1, width: 2000, height: 2000, players, food: [[10, 10]] });

const mockStream = (page, snap) =>
  page.route("**/api/blobs/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `retry: 100\n\nevent: state\ndata: ${JSON.stringify(snap)}\n\n`,
    }),
  );

test("shows the 10 heaviest players in mass order and names as text", async ({ page }) => {
  const players = Array.from({ length: 12 }, (_, i) => player(i + 1, 100 - i * 5, { bot: i === 1 }));
  players[3].name = "<b>bold</b>";
  await mockStream(page, snapshot(players));
  await page.goto("/blobs");
  const rows = page.locator("#blobs-leaderboard li[data-player-id]");
  await expect(rows).toHaveCount(10);
  await expect(page.locator("#blobs-leaderboard h2")).toHaveText("Leaderboard");
  const ids = await rows.evaluateAll((els) => els.map((el) => el.dataset.playerId));
  expect(ids).toEqual(players.slice(0, 10).map((p) => p.id));
  await expect(rows.nth(3)).toContainText("<b>bold</b>");
  await expect(rows.nth(3).locator("b")).toHaveCount(0);
  await expect(rows.nth(0)).toContainText("100");
  await expect(rows.nth(1)).toHaveClass(/bot/);
});

test("your own row is marked me and an out-of-top-10 player gets an extra rank row", async ({ page }) => {
  const players = Array.from({ length: 12 }, (_, i) => player(i + 1, 100 - i * 5));
  const me = players[11];
  await page.route("**/api/blobs/join", (route) =>
    route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(me) }),
  );
  await mockStream(page, snapshot(players));
  await page.goto("/blobs");
  await page.waitForFunction(() => window.__blobs?.state);
  await page.fill("#blobs-name", me.name);
  await page.click("#blobs-play");
  const mine = page.locator("#blobs-leaderboard li.me");
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText("#12");
  await expect(mine).toContainText(me.name);
  await expect(page.locator("#blobs-leaderboard li[data-player-id]")).toHaveCount(11);
});

test("joining the live arena shows your row", async ({ page }) => {
  const name = uniqueName();
  await page.goto("/blobs");
  await page.waitForFunction(() => window.__blobs?.state);
  await page.fill("#blobs-name", name);
  await page.click("#blobs-play");
  await expect(page.locator("#blobs-leaderboard li.me")).toContainText(name);
  await page.evaluate(() => window.__blobs.leave());
});
