import http from "node:http";
import { handleTodos } from "./todos.js";

export function renderPage() {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Hello</title></head>
  <body><h1 id="greeting">Hello, world!</h1></body>
</html>`;
}

const port = Number(process.env.PORT || 3000);

http
  .createServer(async (req, res) => {
    if (await handleTodos(req, res)) return;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderPage());
  })
  .listen(port, () => console.log(`listening on http://localhost:${port}`));
