import http from "node:http";
import { handleTodos } from "./todos.js";
import { renderTodosPage } from "./todos-page.js";

export function renderPage() {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Hello</title></head>
  <body><h1 id="greeting">Hello, world!</h1><p><a id="todos-link" href="/todos">Todos</a></p></body>
</html>`;
}

const port = Number(process.env.PORT || 3000);

http
  .createServer(async (req, res) => {
    try {
      if (await handleTodos(req, res)) return;
      const path = req.url.split("?")[0];
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(path === "/todos" ? renderTodosPage() : renderPage());
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  })
  .listen(port, () => console.log(`listening on http://localhost:${port}`));
