function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

// `body` and `head` are inserted as raw HTML and must be trusted markup only; `title` is escaped.
export function layout({ title, body, head = "" }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/static/styles.css">
    ${head}
  </head>
  <body>
    <header class="site-header">
      <nav><a href="/">Home</a> <a id="world-link" href="/world">World</a> <a id="pixels-link" href="/pixels">Pixels</a> <a id="polls-link" href="/polls">Polls</a> <a id="blobs-link" href="/blobs">Blobs</a></nav>
    </header>
    <main>${body}</main>
  </body>
</html>`;
}

export function renderNotFound() {
  return layout({
    title: "Page not found",
    body: `<h1 id="not-found">Page not found</h1>
<p>The page you asked for does not exist. <a href="/">Back to Home</a></p>`,
  });
}
