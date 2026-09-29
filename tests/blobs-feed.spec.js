import { test, expect } from "@playwright/test";

const view = (id, name, mass, bot = false) => ({
  id, name, color: "#3498db", x: 500, y: 500, mass, radius: 4 * Math.sqrt(mass), bot, peakMass: mass,
});
const at = () => new Date().toISOString();
const eaten = (eater, victim) => ({ type: "eaten", eater, victim, at: at() });

// The first stream connection made once `ready()` is true gets the events; before that EventSource polls
// quickly, afterwards a long retry keeps it from replaying them.
async function mockStream(page, players, events, ready = () => true) {
  const snapshot = { tick: 1, width: 2000, height: 2000, players, food: [[10, 10]] };
  let sent = false;
  await page.route("**/api/blobs/stream", (route) => {
    let body = `retry: ${sent || ready() ? 3600000 : 100}\n\nevent: state\ndata: ${JSON.stringify(snapshot)}\n\n`;
    if (!sent && ready()) {
      sent = true;
      for (const { type, ...data } of events) body += `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    }
    return route.fulfill({ status: 200, contentType: "text/event-stream", body });
  });
}

const items = (page) => page.locator("#blobs-feed li");

test("an eaten event shows who ate whom with the rounded victim mass", async ({ page }) => {
  const alice = view("aaaa0001", "Alice", 50);
  const bob = view("bbbb0002", "Bob", 20.6);
  await mockStream(page, [alice, bob], [eaten(alice, bob)]);
  await page.goto("/blobs");
  await expect(items(page)).toHaveText(["Alice ate Bob (21)"]);
  await expect(page.locator(".blobs-tool[data-plugin='feed'] #blobs-feed")).toBeVisible();
});

test("7 events leave 5 items, newest first", async ({ page }) => {
  const eater = view("aaaa0001", "Eater", 500);
  const events = Array.from({ length: 7 }, (_, i) => eaten(eater, view(`bbbb000${i}`, `Victim${i}`, 20 + i)));
  await mockStream(page, [eater], events);
  await page.goto("/blobs");
  await expect(items(page)).toHaveText([6, 5, 4, 3, 2].map((i) => `Eater ate Victim${i} (${20 + i})`));
});

test("an item disappears after about 6 seconds", async ({ page }) => {
  const alice = view("aaaa0001", "Alice", 50);
  const bob = view("bbbb0002", "Bob", 20);
  await mockStream(page, [alice, bob], [eaten(alice, bob)]);
  await page.goto("/blobs");
  await expect(items(page)).toHaveCount(1);
  const shownAt = Date.now();
  await page.waitForTimeout(4500);
  await expect(items(page)).toHaveCount(1);
  await expect(items(page)).toHaveCount(0, { timeout: 4000 });
  expect(Date.now() - shownAt).toBeGreaterThan(5500);
});

test("own kill and own death are marked", async ({ page }) => {
  const me = view("abcd1234", "me", 60);
  const prey = view("bbbb0002", "Prey", 20);
  const hunter = view("cccc0003", "Hunter", 200);
  let joined = false;
  await page.route("**/api/blobs/join", (route) => {
    joined = true;
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(me) });
  });
  await mockStream(page, [me, prey, hunter], [eaten(me, prey), eaten(hunter, me)], () => joined);
  await page.goto("/blobs");
  await page.waitForFunction(() => window.__blobs?.state);
  await page.fill("#blobs-name", "me");
  await page.click("#blobs-play");
  await expect(items(page)).toHaveCount(2);
  await expect(items(page).nth(1)).toHaveClass("mine-kill");
  await expect(items(page).nth(1)).toHaveText("me ate Prey (20)");
  await expect(items(page).nth(0)).toHaveClass("mine-death");
  await expect(items(page).nth(0)).toHaveText("Hunter ate me (60)");
});

test("only humans joining are announced", async ({ page }) => {
  const events = [
    { type: "joined", player: view("bbbb0001", "Botty", 20, true), at: at() },
    { type: "joined", player: view("cccc0002", "Human", 20, false), at: at() },
  ];
  await mockStream(page, [], events);
  await page.goto("/blobs");
  await expect(items(page)).toHaveText(["Human joined"]);
  await expect(items(page)).toHaveClass("join");
});

test("names are shown as text, not HTML", async ({ page }) => {
  const evil = view("aaaa0001", "<img src=x onerror=window.__pwned=1>", 50);
  const bob = view("bbbb0002", "Bob", 20);
  await mockStream(page, [evil, bob], [eaten(evil, bob)]);
  await page.goto("/blobs");
  await expect(items(page)).toHaveText(["<img src=x onerror=window.__pwned=1> ate Bob (20)"]);
  await expect(page.locator("#blobs-feed img")).toHaveCount(0);
});
