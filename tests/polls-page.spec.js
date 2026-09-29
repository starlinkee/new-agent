import { test, expect } from "@playwright/test";

const suffix = () => Math.random().toString(36).slice(2, 8);

// Polls are shared server state: every test creates its own poll and asserts on that one only.
async function createViaUi(page, question, options = ["Red", "Green", "Blue"]) {
  await page.goto("/polls");
  await page.fill("#poll-question", question);
  for (let i = 2; i < options.length; i++) await page.click("#poll-add-option");
  const inputs = page.locator("#poll-options input");
  await expect(inputs).toHaveCount(options.length);
  for (let i = 0; i < options.length; i++) await inputs.nth(i).fill(options[i]);
  await page.click("#poll-create");
  await expect(page.locator("#poll-view")).toBeVisible();
  return new URL(page.url()).searchParams.get("id");
}

test.describe("polls page", () => {
  test("nav link reaches /polls", async ({ page }) => {
    await page.goto("/");
    await page.click("#polls-link");
    await expect(page).toHaveURL(/\/polls$/);
    await expect(page.locator("#poll-form")).toBeVisible();
    await expect(page.locator("#poll-options input")).toHaveCount(2);
    await expect(page.locator("#poll-options button")).toHaveCount(0);
  });

  test("creating a poll with 3 options lands on its view and lists it", async ({ page }) => {
    const question = `Colour ${suffix()}?`;
    const id = await createViaUi(page, question);
    await expect(page).toHaveURL(new RegExp(`/polls\\?id=${id}$`));
    await expect(page.locator("#poll-question-text")).toHaveText(question);
    await expect(page.locator("button.poll-option")).toHaveText([/Red/, /Green/, /Blue/]);
    await expect(page.locator("#poll-total")).toHaveText("0 votes");
    await expect(page.locator(".poll-percent").first()).toHaveText("0%");

    await page.goto("/polls");
    const link = page.locator(`#poll-list a.poll-link[href="/polls?id=${id}"]`);
    await expect(link).toContainText(question);
    await expect(link).toContainText("0 votes");
  });

  test("added options beyond 2 can be removed and the total is capped at 8", async ({ page }) => {
    await page.goto("/polls");
    for (let i = 0; i < 6; i++) await page.click("#poll-add-option");
    await expect(page.locator("#poll-options input")).toHaveCount(8);
    await expect(page.locator("#poll-add-option")).toBeDisabled();
    await page.locator("#poll-options button").first().click();
    await expect(page.locator("#poll-options input")).toHaveCount(7);
    await expect(page.locator("#poll-add-option")).toBeEnabled();
  });

  test("voting marks the option and changing the vote moves it", async ({ page }) => {
    await createViaUi(page, `Vote ${suffix()}?`);
    const options = page.locator("button.poll-option");
    await options.nth(1).click();
    await expect(options.nth(1)).toHaveAttribute("aria-pressed", "true");
    await expect(options.nth(1).locator(".poll-count")).toHaveText("1");
    await expect(options.nth(1).locator(".poll-percent")).toHaveText("100%");
    await expect(page.locator("#poll-total")).toHaveText("1 vote");

    await options.nth(2).click();
    await expect(options.nth(2)).toHaveAttribute("aria-pressed", "true");
    await expect(options.nth(1)).toHaveAttribute("aria-pressed", "false");
    await expect(options.nth(1).locator(".poll-count")).toHaveText("0");
    await expect(options.nth(2).locator(".poll-percent")).toHaveText("100%");
    await expect(page.locator("#poll-total")).toHaveText("1 vote");
  });

  test("a vote from a second browser context shows after reload", async ({ page, browser }) => {
    const id = await createViaUi(page, `Two voters ${suffix()}?`);
    await page.locator("button.poll-option").nth(0).click();
    await expect(page.locator("#poll-total")).toHaveText("1 vote");

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto(`/polls?id=${id}`);
    await otherPage.locator("button.poll-option").nth(1).click();
    await expect(otherPage.locator("#poll-total")).toHaveText("2 votes");
    await other.close();

    await page.reload();
    await expect(page.locator("#poll-total")).toHaveText("2 votes");
    await expect(page.locator("button.poll-option").nth(0)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("button.poll-option").nth(0).locator(".poll-percent")).toHaveText("50%");
    await expect(page.locator("button.poll-option").nth(1)).toHaveAttribute("aria-pressed", "false");
  });

  test("a blank question shows the server error", async ({ page }) => {
    await page.goto("/polls");
    await page.locator("#poll-options input").nth(0).fill("A");
    await page.locator("#poll-options input").nth(1).fill("B");
    await page.click("#poll-create");
    await expect(page.locator("#poll-error")).toHaveAttribute("role", "alert");
    await expect(page.locator("#poll-error")).toContainText("question");
    await expect(page).toHaveURL(/\/polls$/);
  });

  test("an unknown id shows Poll not found and no options", async ({ page }) => {
    await page.goto("/polls?id=doesnotexist");
    await expect(page.locator("#poll-status")).toHaveText("Poll not found");
    await expect(page.locator("button.poll-option")).toHaveCount(0);
  });

  test("a rejected vote shows the error and keeps the previous state", async ({ page }) => {
    await createViaUi(page, `Reject ${suffix()}?`);
    const options = page.locator("button.poll-option");
    await options.nth(0).click();
    await expect(options.nth(0)).toHaveAttribute("aria-pressed", "true");
    await page.route("**/api/polls/*/vote", (route) =>
      route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "poll closed" }) }),
    );
    await options.nth(1).click();
    await expect(page.locator("#poll-status")).toHaveText("poll closed");
    await expect(page.locator("#poll-status")).toHaveAttribute("role", "status");
    await expect(options.nth(0)).toHaveAttribute("aria-pressed", "true");
    await expect(options.nth(1)).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#poll-total")).toHaveText("1 vote");
  });

  test("a closed poll disables its options", async ({ page }) => {
    await createViaUi(page, `Closed ${suffix()}?`);
    await page.evaluate(() =>
      window.__polls.render({ ...window.__polls.poll, closesAt: new Date(Date.now() - 1000).toISOString() }),
    );
    await expect(page.locator("#poll-view")).toHaveClass(/closed/);
    await expect(page.locator("button.poll-option[disabled]")).toHaveCount(3);
  });

  test("window.__polls.poll matches the rendered state", async ({ page }) => {
    await createViaUi(page, `Handle ${suffix()}?`);
    await page.locator("button.poll-option").nth(2).click();
    await expect(page.locator("#poll-total")).toHaveText("1 vote");
    const poll = await page.evaluate(() => window.__polls.poll);
    expect(poll.myVote).toBe(2);
    expect(poll.total).toBe(1);
    expect(poll.tallies).toEqual([0, 0, 1]);
    await page.evaluate(() => window.__polls.vote(0));
    await expect(page.locator("button.poll-option").nth(0)).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => window.__polls.poll.myVote)).toBe(0);
  });

  test("the deadline select sends durationSec", async ({ page }) => {
    await page.goto("/polls");
    let body;
    await page.route("**/api/polls", (route) => {
      if (route.request().method() === "POST") body = route.request().postDataJSON();
      return route.continue();
    });
    await page.fill("#poll-question", `Deadline ${suffix()}?`);
    await page.locator("#poll-options input").nth(0).fill("A");
    await page.locator("#poll-options input").nth(1).fill("B");
    await page.selectOption("#poll-duration", { label: "1 hour" });
    await page.click("#poll-create");
    await expect(page.locator("#poll-view")).toBeVisible();
    expect(body.durationSec).toBe(3600);
    expect(await page.evaluate(() => window.__polls.poll.closesAt)).not.toBeNull();
  });
});
