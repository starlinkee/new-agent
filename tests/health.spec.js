import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

test("GET /health returns status, uptime and version", async ({ request }) => {
  const res = await request.get("/health");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/json");
  const body = await res.json();
  expect(body).toEqual({
    status: "ok",
    uptimeSeconds: expect.any(Number),
    version,
  });
  expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
});

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`${method} /health returns 405`, async ({ request }) => {
    const res = await request.fetch("/health", { method });
    expect(res.status()).toBe(405);
  });
}

test("/ still renders the greeting", async ({ request }) => {
  const res = await request.get("/");
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("Hello, world!");
});
