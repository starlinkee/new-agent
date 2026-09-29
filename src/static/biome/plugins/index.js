// Plugin registry. Each plugin ticket adds exactly ONE import line and ONE entry to PLUGINS,
// nothing else, so parallel tickets merge without conflicts. Plugins are independent of each
// other and their order does not matter.

import * as feeding from "./feeding.js";
import * as inspector from "./inspector.js";

export const PLUGINS = [feeding, inspector];

// Mounts every plugin once with the page context; a plugin that throws is skipped and the rest
// still mount. Returns a cleanup that unmounts them all.
export function mountPlugins(ctx) {
  const cleanups = [];
  for (const plugin of PLUGINS) {
    try {
      const cleanup = plugin.mount(ctx);
      if (typeof cleanup === "function") cleanups.push(cleanup);
    } catch (err) {
      console.error("biome plugin failed to mount", err);
    }
  }
  return () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (err) {
        console.error("biome plugin cleanup failed", err);
      }
    }
  };
}
