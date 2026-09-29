const STATIC_DIR = new URL("./static/", import.meta.url);

// Module resolve hook: the browser sim modules import each other as "/static/<file>", which Node cannot resolve.
// Maps those specifiers onto src/static so the sim can be imported unmodified on the server.
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("/static/")) {
    return nextResolve(new URL(specifier.slice("/static/".length), STATIC_DIR).href, context);
  }
  return nextResolve(specifier, context);
}
