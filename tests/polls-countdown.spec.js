import { test, expect } from "@playwright/test";

const suffix = () => Math.random().toString(36).slice(2, 8);

const mockPoll = (over = {}) => ({
  id: "cafe0001",
  question: `Countdown ${suffix()}?`,
  options: ["Yes", "No"],
  closesAt: null,
  createdAt: new Date().toISOString(),
  tallies: [0, 0],
  total: 0,
  myVote: null,
  ...over,
});

async function openMocked(page, poll) {
  await page.route(`**/api/polls/${poll.id}`, (route) => route.fulfill({ json: poll }));
  await page.goto(`/polls?id=${poll.id}`);
  await expect(page.locator("#poll-view")).toBeVisible();
}

test.describe("polls countdown", () => {
  test("a poll without a deadline has no countdown", async ({ page, request }) => {
    const poll = await (await request.post("/api/polls", { data: { question: `Open ${suffix()}?`, options: ["A", "B"] } })).json();
    await page.goto(`/polls?id=${poll.id}`);
    await expect(page.locator("button.poll-option")).toHaveCount(2);
    await expect(page.locator("#poll-countdown")).toHaveCount(0);
  });

  test("counts down then closes the poll", async ({ page }) => {
    const poll = mockPoll({ closesAt: new Date(Date.now() + 3000).toISOString() });
    await openMocked(page, poll);
    await expect(page.locator("#poll-countdown")).toHaveText(/^Closes in 0:0\d$/);
    await expect(page.locator("button.poll-option").first()).toBeEnabled();
    await expect(page.locator("#poll-countdown")).toHaveText("Closed", { timeout: 5000 });
    await expect(page.locator("#poll-view")).toHaveClass(/closed/);
    for (const button of await page.locator("button.poll-option").all()) await expect(button).toBeDisabled();
  });

  test("a poll already closed is disabled on load", async ({ page }) => {
    const poll = mockPoll({ closesAt: new Date(Date.now() - 60000).toISOString() });
    await openMocked(page, poll);
    await expect(page.locator("#poll-countdown")).toHaveText("Closed");
    await expect(page.locator("#poll-view")).toHaveClass(/closed/);
    for (const button of await page.locator("button.poll-option").all()) await expect(button).toBeDisabled();
  });

  test("a real poll with a one hour duration shows the remaining time", async ({ page, request }) => {
    const poll = await (
      await request.post("/api/polls", { data: { question: `Hour ${suffix()}?`, options: ["A", "B"], durationSec: 3600 } })
    ).json();
    await page.goto(`/polls?id=${poll.id}`);
    await expect(page.locator("#poll-countdown")).toHaveText(/^Closes in (59:|1:00:00)/);
  });
});
