const todos = new Map();
let nextId = 1;

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("body must be a JSON object"));
        } else {
          resolve(parsed);
        }
      } catch {
        reject(new Error("malformed JSON"));
      }
    });
    req.on("error", reject);
  });
}

function validTitle(title) {
  return typeof title === "string" && title.trim() !== "";
}

// Handles /api/todos requests. Returns true when the request was handled.
export async function handleTodos(req, res) {
  const url = new URL(req.url, "http://localhost");
  const match = /^\/api\/todos(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (!match) return false;
  const id = match[1];

  if (id === undefined) {
    if (req.method === "GET") {
      send(res, 200, [...todos.values()]);
    } else if (req.method === "POST") {
      let body;
      try {
        body = await readJson(req);
      } catch (err) {
        return send(res, 400, { error: err.message }), true;
      }
      if (!validTitle(body.title)) {
        return send(res, 400, { error: "title is required" }), true;
      }
      const todo = { id: nextId++, title: body.title.trim(), done: false };
      todos.set(todo.id, todo);
      send(res, 201, todo);
    } else {
      send(res, 405, { error: "method not allowed" });
    }
    return true;
  }

  const todo = /^\d+$/.test(id) ? todos.get(Number(id)) : undefined;

  if (req.method === "PATCH") {
    let body;
    try {
      body = await readJson(req);
    } catch (err) {
      return send(res, 400, { error: err.message }), true;
    }
    if (!todo) return send(res, 404, { error: "todo not found" }), true;
    if ("title" in body && !validTitle(body.title)) {
      return send(res, 400, { error: "title must be a non-empty string" }), true;
    }
    if ("done" in body && typeof body.done !== "boolean") {
      return send(res, 400, { error: "done must be a boolean" }), true;
    }
    if ("title" in body) todo.title = body.title.trim();
    if ("done" in body) todo.done = body.done;
    send(res, 200, todo);
  } else if (req.method === "DELETE") {
    if (!todo) return send(res, 404, { error: "todo not found" }), true;
    todos.delete(todo.id);
    send(res, 204);
  } else {
    send(res, 405, { error: "method not allowed" });
  }
  return true;
}
