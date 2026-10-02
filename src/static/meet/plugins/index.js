import * as best from "./best.js";

export const PLUGINS = [best];

// Mounts every plugin once; a plugin that throws does not stop the others. Returns one cleanup.
export function mountPlugins(ctx) {
  const cleanups = [];
  for (const plugin of PLUGINS) {
    try {
      const cleanup = plugin.mount(ctx);
      if (typeof cleanup === "function") cleanups.push(cleanup);
    } catch (err) {
      console.error("meet plugin failed to mount", err);
    }
  }
  return () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch (err) {
        console.error("meet plugin failed to clean up", err);
      }
    }
  };
}
