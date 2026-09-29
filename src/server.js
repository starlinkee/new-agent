import http from "node:http";
import { handleTodos } from "./todos.js";
import { renderTodosPage } from "./todos-page.js";
import { renderWorldPage } from "./world-page.js";
import { layout } from "./layout.js";
import { handleRequest } from "./site.js";
import { handleHealth } from "./health.js";
import { handleSnapshots } from "./world-snapshots.js";
import { handlePixels } from "./pixels.js";

export function renderPage() {
  return layout({
    title: "Hello",
    body: `<h1 id="greeting">Hello, world!</h1><p><a id="todos-link" href="/todos">Todos</a></p>`,
  });
}

const port = Number(process.env.PORT || 3000);

http
  .createServer(async (req, res) => {
    try {
      if (new URL(req.url, "http://localhost").pathname === "/health") return handleHealth(req, res);
      if (await handleTodos(req, res)) return;
      if (await handleSnapshots(req, res)) return;
      if (await handlePixels(req, res)) return;
      await handleRequest(req, res, { "/": renderPage, "/todos": renderTodosPage, "/world": renderWorldPage });
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  })
  .listen(port, () => console.log(`listening on http://localhost:${port}`));
