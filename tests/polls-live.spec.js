import { test, expect } from "@playwright/test";

const suffix = () => Math.random().toString(36).slice(2, 8);

// Polls are shared server state: each test creates its own poll and asserts on that one only.
async function createPoll(request, options = ["Red", "Green"]) {
  const res = await request.post("/api/polls", { data: { question: `Live ${suffix()}?`, options } });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

async function openPoll(browser, id) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/polls?id=${id}`);
  await expect(page.locator("#poll-live")).toHaveText("Live");
  return { context, page };
}

test.describe("polls live results", () => {
  test("a vote in one context updates counts and total in another without reload", async ({ browser, request }) => {
    const id = await createPoll(request);
    const a = await openPoll(browser, id);
    const b = await openPoll(browser, id);
    await a.page.locator('button.poll-option[data-option="1"]').click();
    await expect(a.page.locator("#poll-total")).toHaveText("1 vote");
    const other = b.page.locator('button.poll-option[data-option="1"]');
    await expect(other.locator(".poll-count")).toHaveText("1");
    await expect(b.page.locator("#poll-total")).toHaveText("1 vote");
    await expect(other).toHaveAttribute("aria-pressed", "false");
    await a.context.close();
    await b.context.close();
  });

  test("votes on another poll do not change this one", async ({ browser, request }) => {
    const id = await createPoll(request);
    const otherId = await createPoll(request);
    const { context, page } = await openPoll(browser, id);
    const voter = await request.post(`/api/polls/${otherId}/vote`, { data: { option: 0 } });
    expect(voter.status()).toBe(200);
    await request.post(`/api/polls/${id}/vote`, { data: { option: 0 } });
    await expect(page.locator("#poll-total")).toHaveText("1 vote");
    await expect(page.locator('button.poll-option[data-option="0"] .poll-count')).toHaveText("1");
    await context.close();
  });

  test("the stream sends a snapshot then vote events for its poll only", async ({ browser, request }) => {
    const id = await createPoll(request);
    const { context, page } = await openPoll(browser, id);
    const events = await page.evaluate(
      (pollId) =>
        new Promise((resolve) => {
          const got = [];
          const source = new EventSource(`/api/polls/${pollId}/events`);
          for (const name of ["snapshot", "vote"]) {
            source.addEventListener(name, (e) => {
              got.push({ name, data: JSON.parse(e.data) });
              if (name === "snapshot") {
                fetch(`/api/polls/${pollId}/vote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ option: 1 }) });
              } else {
                source.close();
                resolve(got);
              }
            });
          }
        }),
      id,
    );
    expect(events[0]).toEqual({ name: "snapshot", data: { tallies: [0, 0], total: 0 } });
    expect(events[1].name).toBe("vote");
    expect(events[1].data.tallies).toEqual([0, 1]);
    expect(events[1].data.total).toBe(1);
    expect(Number.isNaN(Date.parse(events[1].data.at))).toBe(false);
    await context.close();
  });

  test("unknown poll -> 404 and wrong method -> 405", async ({ request }) => {
    const missing = await request.get("/api/polls/nope1234/events");
    expect(missing.status()).toBe(404);
    expect(await missing.json()).toEqual({ error: "poll not found" });
    const id = await createPoll(request);
    const wrong = await request.post(`/api/polls/${id}/events`, { data: {} });
    expect(wrong.status()).toBe(405);
    expect(wrong.headers().allow).toBe("GET");
  });
});
