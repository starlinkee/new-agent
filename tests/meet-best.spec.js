import { test, expect } from "@playwright/test";

const suffix = () => Math.random().toString(36).slice(2, 8);

async function createEvent(request) {
  const res = await request.post("/api/meet", {
    data: { title: `Best ${suffix()}`, dates: ["2030-03-04"], startMinute: 540, endMinute: 720, timezone: "UTC" },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

async function respond(playwright, baseURL, id, name, slots) {
  const api = await playwright.request.newContext({ baseURL });
  const res = await api.put(`/api/meet/${id}/availability`, { data: { name, slots } });
  expect(res.status()).toBe(200);
  await api.dispose();
}

const items = (page) => page.locator("#meet-best li.meet-best-item");

test.describe("meet best times panel", () => {
  test("lists the best blocks with who is missing", async ({ page, playwright, baseURL }) => {
    const event = await createEvent(page.request);
    await respond(playwright, baseURL, event.id, "Ala", [0, 1, 2, 3]);
    await respond(playwright, baseURL, event.id, "Bob", [2, 3, 4, 5]);
    await respond(playwright, baseURL, event.id, "Cyd", [3, 4]);
    await page.goto(`/meet?id=${event.id}`);
    await expect(page.locator("#meet-best h4")).toHaveText("Best times");
    await expect(items(page)).toHaveCount(3);
    const expected = [
      ["Mon 4 Mar, 10:30–11:00", "3 of 3 free", "Everyone can make it"],
      ["Mon 4 Mar, 10:00–10:30", "2 of 3 free", "Missing: Cyd"],
      ["Mon 4 Mar, 11:00–11:30", "2 of 3 free", "Missing: Ala"],
    ];
    for (const [i, parts] of expected.entries()) {
      for (const text of parts) await expect(items(page).nth(i)).toContainText(text);
    }
    await expect(page.locator("#meet-best .meet-best-empty")).toBeHidden();
  });

  test("without a free slot it says there is no common time", async ({ page }) => {
    const event = await createEvent(page.request);
    await page.goto(`/meet?id=${event.id}`);
    await expect(page.locator("#meet-best")).toContainText("No common time yet");
    await expect(items(page)).toHaveCount(0);
  });

  test("re-renders on change", async ({ page, playwright, baseURL }) => {
    const event = await createEvent(page.request);
    await respond(playwright, baseURL, event.id, "Ala", [0, 1]);
    await page.goto(`/meet?id=${event.id}`);
    await expect(items(page)).toHaveCount(1);
    await expect(items(page).first()).toContainText("Mon 4 Mar, 09:00–10:00");
    await respond(playwright, baseURL, event.id, "Bob", [1, 2]);
    await page.evaluate(async (id) => {
      const next = await (await fetch(`/api/meet/${id}`)).json();
      window.__meet.ctx.setEvent(next);
    }, event.id);
    await expect(items(page)).toHaveCount(3);
    await expect(items(page).first()).toContainText("Mon 4 Mar, 09:30–10:00");
    await expect(items(page).first()).toContainText("2 of 2 free");
  });

  test("hovering an item outlines its slots with its own overlays", async ({ page, playwright, baseURL }) => {
    const event = await createEvent(page.request);
    await respond(playwright, baseURL, event.id, "Ala", [0, 1, 2]);
    await respond(playwright, baseURL, event.id, "Bob", [1, 2, 3]);
    await page.goto(`/meet?id=${event.id}`);
    // slots 1-2 are free for both: the first block spans two slots
    await expect(items(page).first()).toContainText("Mon 4 Mar, 09:30–10:30");
    const before = await page.locator("#meet-group-grid .meet-cell").evaluateAll((cells) => cells.map((c) => c.className));
    await expect(page.locator(".meet-best-highlight")).toHaveCount(0);
    await items(page).first().hover();
    await expect(page.locator("#meet-best .meet-best-highlight")).toHaveCount(2);
    const boxes = await page.locator(".meet-best-highlight").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
    const cells = [1, 2].map((i) => page.locator(`#meet-group-grid .meet-cell[data-slot="${i}"]`).boundingBox());
    const [c1, c2] = await Promise.all(cells);
    expect(boxes[0].x).toBeCloseTo(c1.x, 0);
    expect(boxes[0].y).toBeCloseTo(c1.y, 0);
    expect(boxes[1].y).toBeCloseTo(c2.y, 0);
    expect(await page.locator("#meet-group-grid .meet-cell").evaluateAll((cs) => cs.map((c) => c.className))).toEqual(before);
    await page.mouse.move(0, 0);
    await expect(page.locator(".meet-best-highlight")).toHaveCount(0);
  });
});
