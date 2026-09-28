import { test, expect } from "@playwright/test";

test.describe("todos UI", () => {
  test.beforeEach(async ({ page, request }) => {
    const todos = await (await request.get("/api/todos")).json();
    for (const t of todos) await request.delete(`/api/todos/${t.id}`);
    await page.goto("/todos");
  });

  test("home page links to /todos", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Todos" }).click();
    await expect(page).toHaveURL(/\/todos$/);
    await expect(page.locator("#new-todo")).toBeVisible();
  });

  test("adds a todo without reloading", async ({ page }) => {
    await page.evaluate(() => (window.marker = true));
    await page.fill("#new-todo", "buy milk");
    await page.click("#add-todo");
    const item = page.locator("#todo-list li[data-id]");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText("buy milk");
    await expect(page.locator("#new-todo")).toHaveValue("");
    expect(await page.evaluate(() => window.marker)).toBe(true);
  });

  test("toggles done and persists through the API", async ({ page, request }) => {
    await page.fill("#new-todo", "walk dog");
    await page.click("#add-todo");
    const toggle = page.locator("li[data-id] .todo-toggle");
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();
    const todos = await (await request.get("/api/todos")).json();
    expect(todos.map((t) => t.done)).toEqual([true]);
    await toggle.uncheck();
    await expect(toggle).not.toBeChecked();
  });

  test("deletes a todo", async ({ page }) => {
    await page.fill("#new-todo", "one");
    await page.click("#add-todo");
    // The page clears the input once the POST returns; wait for it, or that
    // late clear wipes "two" while it is being typed.
    await expect(page.locator("li[data-id]")).toHaveCount(1);
    await page.fill("#new-todo", "two");
    await page.click("#add-todo");
    await expect(page.locator("li[data-id]")).toHaveCount(2);
    await page.locator("li[data-id]", { hasText: "one" }).locator(".todo-delete").click();
    await expect(page.locator("li[data-id]")).toHaveCount(1);
    await expect(page.locator("li[data-id]")).toContainText("two");
  });

  test("shows an inline error for an empty title and clears it on success", async ({ page }) => {
    await page.click("#add-todo");
    await expect(page.locator("#todo-error")).toBeVisible();
    await expect(page.locator("#todo-error")).toContainText("title must be a non-empty string");
    await expect(page.locator("li[data-id]")).toHaveCount(0);
    await page.fill("#new-todo", "ok");
    await page.click("#add-todo");
    await expect(page.locator("li[data-id]")).toHaveCount(1);
    await expect(page.locator("#todo-error")).toBeHidden();
  });

  test("renders titles as text, not HTML", async ({ page }) => {
    await page.fill("#new-todo", "<b>bold</b>");
    await page.click("#add-todo");
    await expect(page.locator("li[data-id] .todo-title")).toHaveText("<b>bold</b>");
    await expect(page.locator("li[data-id] b")).toHaveCount(0);
  });
});
