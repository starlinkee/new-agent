import { test, expect, request as playwrightRequest } from "@playwright/test";

const suffix = () => Math.random().toString(36).slice(2, 8);

// Polls are shared server state: each test creates its own poll and asserts on that one only.
async function createPoll(page) {
  const res = await page.request.post("/api/polls", {
    data: { question: `Activity ${suffix()}?`, options: ["Cat", "Dog"] },
  });
  return res.json();
}

test.describe("polls activity chart", () => {
  test("a new poll has no buckets and the page says so", async ({ page }) => {
    const poll = await createPoll(page);
    const res = await page.request.get(`/api/polls/${poll.id}/activity`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ bucketSec: 60, buckets: [] });
    await page.goto(`/polls?id=${poll.id}`);
    await expect(page.locator("#poll-activity-bucket")).toBeVisible();
    await expect(page.getByText("No votes yet")).toBeVisible();
    await expect(page.locator("#poll-activity rect.activity-bar")).toHaveCount(0);
  });

  test("three votes from three clients sum to 3", async ({ page, baseURL }) => {
    const poll = await createPoll(page);
    for (const option of [0, 1, 1]) {
      const voter = await playwrightRequest.newContext({ baseURL });
      const res = await voter.post(`/api/polls/${poll.id}/vote`, { data: { option } });
      expect(res.status()).toBe(200);
      await voter.dispose();
    }
    const res = await page.request.get(`/api/polls/${poll.id}/activity?bucket=3600`);
    const body = await res.json();
    expect(body.bucketSec).toBe(3600);
    expect(body.buckets.reduce((sum, b) => sum + b.votes, 0)).toBe(3);
  });

  test("a vote that moves counts as activity", async ({ page, baseURL }) => {
    const poll = await createPoll(page);
    const voter = await playwrightRequest.newContext({ baseURL });
    await voter.post(`/api/polls/${poll.id}/vote`, { data: { option: 0 } });
    await voter.post(`/api/polls/${poll.id}/vote`, { data: { option: 1 } });
    await voter.dispose();
    const body = await (await page.request.get(`/api/polls/${poll.id}/activity?bucket=3600`)).json();
    expect(body.buckets.reduce((sum, b) => sum + b.votes, 0)).toBe(2);
  });

  test("bad bucket, unknown poll and wrong method are rejected", async ({ page }) => {
    const poll = await createPoll(page);
    for (const bad of ["0", "3601", "abc", "1.5", "-1", ""]) {
      const res = await page.request.get(`/api/polls/${poll.id}/activity?bucket=${bad}`);
      expect(res.status(), `bucket=${bad}`).toBe(400);
    }
    const missing = await page.request.get("/api/polls/ffffffff/activity");
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual({ error: "poll not found" });
    const wrong = await page.request.post(`/api/polls/${poll.id}/activity`, { data: {} });
    expect(wrong.status()).toBe(405);
    expect(wrong.headers().allow).toBe("GET");
  });

  test("voting in the page draws a bar reporting 1 vote", async ({ page }) => {
    const poll = await createPoll(page);
    await page.goto(`/polls?id=${poll.id}`);
    await page.locator('button.poll-option[data-option="0"]').click();
    await expect(page.locator("#poll-total")).toHaveText("1 vote");
    const bars = page.locator("#poll-activity rect.activity-bar");
    await expect(bars.first()).toBeAttached();
    await expect(bars.locator("title", { hasText: /^1 vote$/ }).first()).toBeAttached();
    await expect(page.getByText("No votes yet")).toBeHidden();
  });
});
