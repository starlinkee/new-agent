import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const suffix = () => Math.random().toString(36).slice(2, 8);

// Polls are shared server state: each test creates its own poll and asserts on that one only.
async function createPoll(page, options = ["Cat", "Dog", "Fish"]) {
  const res = await page.request.post("/api/polls", {
    data: { question: `Share ${suffix()}?`, options },
  });
  return res.json();
}

test.describe("polls share plugin", () => {
  test("copy link puts the absolute poll URL on the clipboard", async ({ page, context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const poll = await createPoll(page);
    await page.goto(`/polls?id=${poll.id}`);
    await page.click("#poll-copy-link");
    await expect(page.locator("#poll-share-status")).toHaveText("Link copied");
    await expect(page.locator("#poll-share-url")).toHaveCount(0);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(`${new URL(baseURL).origin}/polls?id=${poll.id}`);
  });

  test("a rejecting clipboard shows a selected read-only input with the URL", async ({ page, baseURL }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new Error("denied")) },
        configurable: true,
      });
    });
    const poll = await createPoll(page);
    await page.goto(`/polls?id=${poll.id}`);
    await page.click("#poll-copy-link");
    const input = page.locator("input#poll-share-url");
    await expect(input).toHaveValue(`${new URL(baseURL).origin}/polls?id=${poll.id}`);
    await expect(input).toHaveJSProperty("readOnly", true);
    await expect(input).toBeFocused();
    await expect(page.locator("#poll-share-status")).not.toHaveText("Link copied");
  });

  test("export downloads poll-<id>.csv matching the tallies after a vote", async ({ page }) => {
    const poll = await createPoll(page);
    await page.goto(`/polls?id=${poll.id}`);
    await page.locator('button.poll-option[data-option="1"]').click();
    await expect(page.locator("#poll-total")).toHaveText("1 vote");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#poll-export-csv")]);
    expect(download.suggestedFilename()).toBe(`poll-${poll.id}.csv`);
    const text = await readFile(await download.path(), "utf8");
    expect(text).toBe("option,votes,percent\r\nCat,0,0.0\r\nDog,1,100.0\r\nFish,0,0.0\r\n");
  });

  test("option text with a comma and a quote is escaped RFC 4180 style", async ({ page }) => {
    const poll = await createPoll(page, ['Say "hi", world', "Plain"]);
    await page.goto(`/polls?id=${poll.id}`);
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#poll-export-csv")]);
    const text = await readFile(await download.path(), "utf8");
    expect(text).toBe('option,votes,percent\r\n"Say ""hi"", world",0,0.0\r\nPlain,0,0.0\r\n');
  });
});
