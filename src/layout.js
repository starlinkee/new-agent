export function layout({ title, body }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <link rel="stylesheet" href="/static/styles.css">
  </head>
  <body>
    <header class="site-header">
      <nav><a href="/">Home</a></nav>
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
