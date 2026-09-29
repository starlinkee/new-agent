// Extension point for /pixels. Each plugin ticket adds exactly ONE import line and
// ONE entry in PLUGINS below, so tickets never touch the same lines.
// A plugin module exports mount(ctx) and may return a cleanup function.
// ctx = { board, canvas, toolbar, redraw, view, onPaint(listener) }; onPaint listeners get { x, y, color }.

import * as live from "./live.js";
import * as viewport from "./viewport.js";

export const PLUGINS = [live, viewport];

// One failing plugin must not stop the page; returns a function that unmounts the plugins that started.
export function mountPlugins(ctx) {
  const cleanups = [];
  for (const plugin of PLUGINS) {
    try {
      cleanups.push(plugin.mount(ctx));
    } catch (err) {
      console.error("pixels plugin failed to mount", err);
    }
  }
  return () => cleanups.forEach((stop) => stop?.());
}
