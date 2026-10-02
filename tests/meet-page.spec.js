import { test, expect } from "@playwright/test";

const suffix = () => Math.random().toString(36).slice(2, 8);

async function createEvent(request, extra = {}) {
  const res = await request.post("/api/meet", {
    data: { title: `Meet ${suffix()}`, dates: ["2030-03-04", "2030-03-05"], startMinute: 540, endMinute: 660, timezone: "UTC", ...extra },
  });
  expect(res.status()).toBe(201);
  return res.json();
}

const cell = (page, grid, i) => page.locator(`${grid} .meet-cell[data-slot="${i}"]`);

async function drag(page, from, to) {
  await cell(page, "#meet-mine-grid", from).hover();
  await page.mouse.down();
  await cell(page, "#meet-mine-grid", to).hover();
  await page.mouse.up();
}

test.describe("meet page: create form", () => {
  test("nav link reaches /meet with 5 dates and 09:00-17:00", async ({ page }) => {
    await page.goto("/");
    await page.click("#meet-link");
    await expect(page).toHaveURL(/\/meet$/);
    await expect(page.locator("#meet-dates li")).toHaveCount(5);
    await expect(page.locator("#meet-from")).toHaveValue("540");
    await expect(page.locator("#meet-to")).toHaveValue("1020");
    await expect(page.locator("#meet-tz")).not.toBeEmpty();
  });

  test("removing and adding dates updates the list, creating opens the event", async ({ page }) => {
    await page.goto("/meet");
    await page.locator("#meet-dates .meet-remove-date").first().click();
    await expect(page.locator("#meet-dates li")).toHaveCount(4);
    await page.fill("#meet-date", "2031-01-02");
    await page.click("#meet-add-date");
    await page.click("#meet-add-date");
    await expect(page.locator("#meet-dates li")).toHaveCount(5);
    await expect(page.locator("#meet-dates li").last()).toContainText("Thu 2 Jan");
    const title = `Party ${suffix()}`;
    await page.fill("#meet-title", title);
    await page.click("#meet-create");
    await expect(page).toHaveURL(/\/meet\?id=[0-9a-f]{8}$/);
    await expect(page.locator("#meet-title-text")).toHaveText(title);
    await expect(page.locator("#meet-tz-note")).toHaveText(/^Times are in .+/);
  });

  test("a server error is shown", async ({ page }) => {
    await page.goto("/meet");
    await page.fill("#meet-title", `Bad ${suffix()}`);
    await page.selectOption("#meet-from", "1020");
    await page.selectOption("#meet-to", "540");
    await page.click("#meet-create");
    await expect(page.locator("#meet-error")).toContainText(/endMinute|startMinute/);
  });
});

test.describe("meet page: event view", () => {
  test("drag, keyboard, save, reload, group heatmap and withdraw", async ({ page, browser, request }) => {
    const ev = await createEvent(request);
    await page.goto(`/meet?id=${ev.id}`);
    await expect(page.locator("#meet-mine-grid .meet-cell")).toHaveCount(8);
    await expect(page.locator("#meet-group-grid .meet-cell")).toHaveCount(8);
    await expect(page.locator("#meet-respondents")).toHaveText("No responses yet");
    await expect(page.locator("#meet-withdraw")).toBeHidden();

    await drag(page, 0, 3);
    expect(await page.evaluate(() => window.__meet.selection)).toEqual([0, 1, 2, 3]);
    await expect(cell(page, "#meet-mine-grid", 2)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#meet-save-status")).toHaveText("Unsaved changes");

    await drag(page, 1, 2);
    expect(await page.evaluate(() => window.__meet.selection)).toEqual([0, 3]);

    await cell(page, "#meet-mine-grid", 5).focus();
    await page.keyboard.press("Space");
    await expect(cell(page, "#meet-mine-grid", 5)).toHaveClass(/selected/);
    await page.keyboard.press("Space");
    await expect(cell(page, "#meet-mine-grid", 5)).not.toHaveClass(/selected/);

    await expect(page.locator("#meet-save")).toBeDisabled();
    await page.fill("#meet-name", "Ann");
    await expect(page.locator("#meet-save")).toBeEnabled();
    const put = page.waitForRequest((r) => r.method() === "PUT");
    await page.click("#meet-save");
    expect((await put).postDataJSON()).toEqual({ name: "Ann", slots: [0, 3] });
    await expect(page.locator("#meet-save-status")).toHaveText("Saved");

    await page.reload();
    await expect(page.locator("#meet-name")).toHaveValue("Ann");
    await expect(cell(page, "#meet-mine-grid", 3)).toHaveClass(/selected/);
    await expect(page.locator("#meet-withdraw")).toBeVisible();

    const other = await browser.newContext();
    const op = await other.newPage();
    await op.goto(`/meet?id=${ev.id}`);
    await op.fill("#meet-name", "Bob");
    await op.evaluate(() => window.__meet.select([3, 4]));
    await op.evaluate(() => window.__meet.save());
    await other.close();

    await page.reload();
    await expect(cell(page, "#meet-group-grid", 3)).toHaveAttribute("data-count", "2");
    await expect(cell(page, "#meet-group-grid", 4)).toHaveAttribute("data-count", "1");
    await expect(cell(page, "#meet-group-grid", 5)).toHaveAttribute("data-count", "0");
    await expect(page.locator("#meet-respondents")).toHaveText("2 people responded");

    await page.click("#meet-withdraw");
    await expect(page.locator("#meet-withdraw")).toBeHidden();
    await page.reload();
    await expect(page.locator("#meet-respondents")).toHaveText("1 person responded");
    await expect(page.locator("#meet-withdraw")).toBeHidden();
  });

  test("setEvent keeps unsaved edits and onHover reports heatmap cells", async ({ page, request }) => {
    const ev = await createEvent(request);
    await page.goto(`/meet?id=${ev.id}`);
    await page.fill("#meet-name", "Cy");
    await page.evaluate(() => {
      window.__hovers = [];
      window.__meet.ctx.onHover((i) => window.__hovers.push(i));
      window.__meet.select([1, 2]);
    });
    await page.evaluate(() => {
      const e = window.__meet.event;
      window.__meet.ctx.setEvent({
        ...e,
        me: undefined,
        participants: [{ id: "aaaaaaaa", name: "Dee", slots: [0], updatedAt: e.createdAt }],
        counts: e.counts.map((_, i) => (i === 0 ? 1 : 0)),
      });
    });
    await expect(cell(page, "#meet-group-grid", 0)).toHaveAttribute("data-count", "1");
    await expect(page.locator("#meet-respondents")).toHaveText("1 person responded");
    expect(await page.evaluate(() => window.__meet.selection)).toEqual([1, 2]);
    await expect(page.locator("#meet-name")).toHaveValue("Cy");

    await cell(page, "#meet-group-grid", 2).hover();
    await page.mouse.move(0, 0);
    expect(await page.evaluate(() => window.__hovers)).toEqual([2, null]);
  });

  test("unknown event id", async ({ page }) => {
    await page.goto("/meet?id=ffffffff");
    await expect(page.locator("#meet-status")).toHaveText("Event not found");
    await expect(page.locator("#meet-mine-grid")).toHaveCount(0);
  });
});

test.describe("meet plugins and slot helpers", () => {
  test("mountPlugins survives a throwing plugin", async ({ page, request }) => {
    const ev = await createEvent(request);
    await page.goto(`/meet?id=${ev.id}`);
    await expect(page.locator("#meet-view")).toBeVisible();
    const mounted = await page.evaluate(async () => {
      const { PLUGINS, mountPlugins } = await import("/static/meet/plugins/index.js");
      let ok = false;
      PLUGINS.push({ mount() { throw new Error("boom"); } }, { mount() { ok = true; } });
      mountPlugins(window.__meet.ctx);
      return ok;
    });
    expect(mounted).toBe(true);
  });

  test("slots.js labels and bestBlocks", async ({ page }) => {
    await page.goto("/meet");
    const out = await page.evaluate(async () => {
      const { slotLabel, rangeLabel, bestBlocks } = await import("/static/meet/slots.js");
      const mk = (dates, startMinute, endMinute, participants) => {
        const per = (endMinute - startMinute) / 30;
        const slots = dates.flatMap((date, d) =>
          Array.from({ length: per }, (_, k) => {
            const m = startMinute + k * 30;
            return { index: d * per + k, date, time: `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}` };
          }),
        );
        return { dates, slotMinutes: 30, slotsPerDay: per, slots, participants };
      };
      const ev = mk(["2030-03-04"], 540, 720, []);
      const late = mk(["2030-03-04"], 1380, 1440, []);
      const p = (name, slots) => ({ name, slots });
      const blocks = mk(["2030-03-04"], 540, 840, [p("A", [0, 1, 2, 3, 4]), p("B", [2, 3, 4, 7]), p("C", [7, 8])]);
      return {
        label: slotLabel(ev, 0),
        range: rangeLabel(ev, 0, 2),
        midnight: rangeLabel(late, 0, 1),
        blocks: bestBlocks(blocks, 5).map((b) => [b.from, b.to, b.count]),
      };
    });
    expect(out.label).toBe("Mon 4 Mar, 09:00");
    expect(out.range).toBe("Mon 4 Mar, 09:00–10:30");
    expect(out.midnight).toBe("Mon 4 Mar, 23:00–24:00");
    // [2-4] A+B (2), [7] B+C (2), [8] C (1), [0-1] A (1); count desc, length desc, earliest first
    expect(out.blocks).toEqual([[2, 4, 2], [7, 7, 2], [0, 1, 1], [8, 8, 1]]);
  });
});
