import { test, expect } from "@playwright/test";

test("home has nav and loads the stylesheet", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Hello");
  await expect(page.locator("header nav a", { hasText: "Home" })).toHaveAttribute("href", "/");
  const css = await request.get("/static/styles.css");
  expect(css.status()).toBe(200);
  expect(css.headers()["content-type"]).toContain("text/css");
});

test("unknown route returns styled 404", async ({ page }) => {
  const response = await page.goto("/nope");
  expect(response.status()).toBe(404);
  await expect(page.locator("h1")).toHaveText("Page not found");
  await expect(page.locator("header nav")).toBeVisible();
});

test("static path traversal does not leak files", async ({ request }) => {
  for (const url of ["/static/../package.json", "/static/%2e%2e/package.json", "/static/..%2fpackage.json"]) {
    const res = await request.get(url);
    expect(res.status(), url).toBe(404);
    expect(await res.text(), url).not.toContain('"name": "new-agent"');
  }
});
