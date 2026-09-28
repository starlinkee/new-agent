import { test, expect } from "@playwright/test";

async function createTodo(request, title) {
  const res = await request.post("/api/todos", { data: { title } });
  expect(res.status()).toBe(201);
  return res.json();
}

test.describe("todos API", () => {
  test("POST creates a todo", async ({ request }) => {
    const res = await request.post("/api/todos", { data: { title: "write tests" } });
    expect(res.status()).toBe(201);
    const todo = await res.json();
    expect(todo).toEqual({ id: expect.anything(), title: "write tests", done: false });
  });

  test("POST assigns unique ids", async ({ request }) => {
    const a = await createTodo(request, "a");
    const b = await createTodo(request, "b");
    expect(a.id).not.toEqual(b.id);
  });

  test("POST rejects missing, empty and blank titles", async ({ request }) => {
    for (const data of [{}, { title: "" }, { title: "   " }, { title: 5 }]) {
      const res = await request.post("/api/todos", { data });
      expect(res.status()).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
  });

  test("POST rejects malformed JSON", async ({ request }) => {
    const res = await request.post("/api/todos", {
      headers: { "content-type": "application/json" },
      data: "{not json",
    });
    expect(res.status()).toBe(400);
    expect(typeof (await res.json()).error).toBe("string");
  });

  test("GET lists created todos", async ({ request }) => {
    const created = await createTodo(request, "listed");
    const res = await request.get("/api/todos");
    expect(res.status()).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toContainEqual(created);
  });

  test("PATCH updates title and done", async ({ request }) => {
    const todo = await createTodo(request, "old");
    const res = await request.patch(`/api/todos/${todo.id}`, { data: { title: "new", done: true } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ id: todo.id, title: "new", done: true });
    const list = await (await request.get("/api/todos")).json();
    expect(list).toContainEqual({ id: todo.id, title: "new", done: true });
  });

  test("PATCH updates a single field", async ({ request }) => {
    const todo = await createTodo(request, "keep");
    const res = await request.patch(`/api/todos/${todo.id}`, { data: { done: true } });
    expect(await res.json()).toEqual({ id: todo.id, title: "keep", done: true });
  });

  test("PATCH rejects invalid values", async ({ request }) => {
    const todo = await createTodo(request, "valid");
    const badTitle = await request.patch(`/api/todos/${todo.id}`, { data: { title: "" } });
    expect(badTitle.status()).toBe(400);
    expect(typeof (await badTitle.json()).error).toBe("string");
    const badDone = await request.patch(`/api/todos/${todo.id}`, { data: { done: "yes" } });
    expect(badDone.status()).toBe(400);
  });

  test("PATCH rejects malformed JSON", async ({ request }) => {
    const todo = await createTodo(request, "json");
    const res = await request.patch(`/api/todos/${todo.id}`, {
      headers: { "content-type": "application/json" },
      data: "{oops",
    });
    expect(res.status()).toBe(400);
  });

  test("PATCH unknown id returns 404", async ({ request }) => {
    const res = await request.patch("/api/todos/999999", { data: { done: true } });
    expect(res.status()).toBe(404);
    expect(typeof (await res.json()).error).toBe("string");
  });

  test("DELETE removes a todo and ids are not reused", async ({ request }) => {
    const todo = await createTodo(request, "delete me");
    const res = await request.delete(`/api/todos/${todo.id}`);
    expect(res.status()).toBe(204);
    const list = await (await request.get("/api/todos")).json();
    expect(list.map((t) => t.id)).not.toContain(todo.id);
    const next = await createTodo(request, "after");
    expect(next.id).not.toEqual(todo.id);
  });

  test("DELETE unknown id returns 404", async ({ request }) => {
    const res = await request.delete("/api/todos/999999");
    expect(res.status()).toBe(404);
    expect(typeof (await res.json()).error).toBe("string");
  });

  test("DELETE twice returns 404 the second time", async ({ request }) => {
    const todo = await createTodo(request, "twice");
    expect((await request.delete(`/api/todos/${todo.id}`)).status()).toBe(204);
    expect((await request.delete(`/api/todos/${todo.id}`)).status()).toBe(404);
  });
});
