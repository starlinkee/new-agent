// Extension point for /blobs. Each plugin ticket adds exactly ONE import line and
// ONE entry in PLUGINS below, so tickets never touch the same lines.
// A plugin module exports mount(ctx) and may return a cleanup function.
// ctx = { root, hud, getState(), getMe(), getCamera(), onState(listener), onEvent(listener) };
// onState listeners get every snapshot after it was drawn, onEvent listeners get { type, ...data }
// for joined, eaten and left events; both return an unsubscribe function.
import * as leaderboard from "./leaderboard.js";
import * as scores from "./scores.js";
import * as feed from "./feed.js";

export const PLUGINS = [leaderboard, scores, feed];

// One failing plugin must not stop the page; returns a function that unmounts the plugins that started.
export function mountPlugins(ctx) {
  const cleanups = [];
  for (const plugin of PLUGINS) {
    try {
      cleanups.push(plugin.mount(ctx));
    } catch (err) {
      console.error("blobs plugin failed to mount", err);
    }
  }
  return () => cleanups.forEach((stop) => stop?.());
}
