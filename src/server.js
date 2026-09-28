import http from "node:http";

export function renderPage() {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Hello</title></head>
  <body><h1 id="greeting">Hello, world!</h1></body>
</html>`;
}

const port = Number(process.env.PORT || 3000);

http
  .createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderPage());
  })
  .listen(port, () => console.log(`listening on http://localhost:${port}`));
