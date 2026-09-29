import { test, expect } from "@playwright/test";

async function open(page) {
  await page.goto("/world");
  await page.waitForFunction(() => window.__atmosphere && window.__world && window.__worldControl);
  // The live sim draws creatures and food over the sky; freeze and empty it so sampled pixels are pure atmosphere.
  await page.evaluate(() => {
    window.__worldControl.paused = true;
    window.__world.creatures = [];
    window.__world.food = [];
  });
}

async function setAndDraw(page, time, weather = "clear") {
  await page.evaluate(([t, w]) => {
    window.__atmosphere.setTime(t);
    window.__atmosphere.setWeather(w);
  }, [time, weather]);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const pixel = (page, x, y) =>
  page.evaluate(([px, py]) => {
    const canvas = document.getElementById("world");
    const ratio = canvas.width / canvas.clientWidth;
    return Array.from(canvas.getContext("2d").getImageData(px * ratio, py * ratio, 1, 1).data);
  }, [x, y]);

test("setting the time of day changes the reported phase", async ({ page }) => {
  await open(page);
  const phases = {};
  for (const [name, t] of [["night", 0], ["dawn", 0.25], ["day", 0.5], ["dusk", 0.75]]) {
    await setAndDraw(page, t);
    phases[name] = await page.evaluate(() => window.__atmosphere.phase());
  }
  expect(phases).toEqual({ night: "night", dawn: "dawn", day: "day", dusk: "dusk" });
});

test("background is brighter at noon than at midnight", async ({ page }) => {
  await open(page);
  await setAndDraw(page, 0.5);
  const noon = await pixel(page, 2, 2);
  await setAndDraw(page, 0);
  const midnight = await pixel(page, 2, 2);
  expect(noon).not.toEqual(midnight);
  expect(noon[0] + noon[1] + noon[2]).toBeGreaterThan(midnight[0] + midnight[1] + midnight[2] + 200);
});

test("rain and snow are reflected in the getter and draw particles", async ({ page }) => {
  await open(page);
  for (const weather of ["rain", "snow"]) {
    await setAndDraw(page, 0.5, weather);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => window.__atmosphere.weather())).toBe(weather);
    const count = await page.evaluate(() => window.__atmosphere.particleCount());
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(weather === "rain" ? 300 : 150);
  }
  // Snow must not inherit rain particles: every flake falls at snow speed.
  const vys = await page.evaluate(() => window.__atmosphere.particleVelocities());
  expect(vys.length).toBeGreaterThan(0);
  expect(Math.max(...vys)).toBeLessThanOrEqual(80);
  await setAndDraw(page, 0.5, "clear");
  expect(await page.evaluate(() => window.__atmosphere.particleCount())).toBe(0);
});

test("weather cycles through clear, rain, snow with 10-25s durations", async ({ page }) => {
  await open(page);
  const seen = await page.evaluate(async () => {
    const { createAtmosphere } = await import("/static/atmosphere.js");
    const a = createAtmosphere();
    const order = [a.weather()];
    const lengths = [];
    let len = 0;
    for (let i = 0; i < 100 * 90; i++) {
      a.update(0.01);
      len += 0.01;
      if (a.weather() !== order[order.length - 1]) {
        order.push(a.weather());
        lengths.push(len);
        len = 0;
      }
    }
    return { order, lengths };
  });
  expect(seen.order.slice(0, 4)).toEqual(["clear", "rain", "snow", "clear"]);
  for (const l of seen.lengths) {
    expect(l).toBeGreaterThan(9.9);
    expect(l).toBeLessThan(25.1);
  }
});
