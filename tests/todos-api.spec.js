import net from "node:net";
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

  test("POST rejects oversized bodies with 413", async ({ request }) => {
    const res = await request.post("/api/todos", { data: { title: "x".repeat(20 * 1024) } });
    expect(res.status()).toBe(413);
    expect(typeof (await res.json()).error).toBe("string");
  });

  test("POST rejects non-JSON content types with 415", async ({ request }) => {
    const res = await request.post("/api/todos", {
      headers: { "content-type": "text/plain" },
      data: JSON.stringify({ title: "csrf" }),
    });
    expect(res.status()).toBe(415);
    const list = await (await request.get("/api/todos")).json();
    expect(list.map((t) => t.title)).not.toContain("csrf");
  });

  test("PATCH rejects non-JSON content types with 415", async ({ request }) => {
    const todo = await createTodo(request, "ct");
    const res = await request.patch(`/api/todos/${todo.id}`, {
      headers: { "content-type": "text/plain" },
      data: JSON.stringify({ done: true }),
    });
    expect(res.status()).toBe(415);
  });

  test("POST rejects over-long titles but accepts the maximum", async ({ request }) => {
    const tooLong = await request.post("/api/todos", { data: { title: "x".repeat(501) } });
    expect(tooLong.status()).toBe(400);
    const ok = await request.post("/api/todos", { data: { title: "y".repeat(500) } });
    expect(ok.status()).toBe(201);
  });

  test("non-numeric ids return 404", async ({ request }) => {
    expect((await request.patch("/api/todos/abc", { data: { done: true } })).status()).toBe(404);
    expect((await request.delete("/api/todos/abc")).status()).toBe(404);
  });

  test("unsupported methods return 405 with an Allow header", async ({ request }) => {
    const collection = await request.put("/api/todos", { data: {} });
    expect(collection.status()).toBe(405);
    expect(collection.headers()["allow"]).toBe("GET, POST");
    const todo = await createTodo(request, "methods");
    const item = await request.get(`/api/todos/${todo.id}`);
    expect(item.status()).toBe(405);
    expect(item.headers()["allow"]).toBe("PATCH, DELETE");
  });

  test("JSON responses set nosniff", async ({ request }) => {
    const res = await request.get("/api/todos");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("GET paginates with limit and offset", async ({ request }) => {
    const a = await createTodo(request, "page-a");
    const b = await createTodo(request, "page-b");
    const all = await (await request.get("/api/todos")).json();
    const start = all.findIndex((t) => t.id === a.id);
    const page = await (await request.get(`/api/todos?limit=2&offset=${start}`)).json();
    expect(page).toEqual([a, b]);
    expect((await request.get("/api/todos?limit=abc")).status()).toBe(400);
    expect((await request.get("/api/todos?limit=0")).status()).toBe(400);
  });

  test("a malformed request target does not crash the server", async ({ request, baseURL }) => {
    const { hostname, port } = new URL(baseURL);
    await new Promise((resolve) => {
      const socket = net.connect(Number(port), hostname, () => {
        socket.write("GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      });
      socket.on("data", () => {});
      socket.on("error", resolve);
      socket.on("close", resolve);
    });
    const res = await request.get("/api/todos");
    expect(res.status()).toBe(200);
  });
});
