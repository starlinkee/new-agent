// Extension point for /pulse. Each plugin ticket adds exactly ONE import line and
// ONE entry in PLUGINS below, so tickets never touch the same lines.
// A plugin module exports mount(ctx) and may return a cleanup function.
// ctx = { site, getRange(), getSummary(), onData(listener), refresh(), addCard({ name, title, span, order }), headerTools }.

import * as install from "./install.js";
import * as devices from "./devices.js";
import * as sources from "./sources.js";
import * as live from "./live.js";

export const PLUGINS = [install, devices, sources, live];

// One failing plugin must not stop the page; returns a function that unmounts the plugins that started.
export function mountPlugins(ctx, plugins = PLUGINS) {
  const cleanups = [];
  for (const plugin of plugins) {
    try {
      cleanups.push(plugin.mount(ctx));
    } catch (err) {
      console.error("pulse plugin failed to mount", err);
    }
  }
  return () => cleanups.forEach((stop) => stop?.());
}
