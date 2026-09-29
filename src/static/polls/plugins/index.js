// Extension point for /polls. Each plugin ticket adds exactly ONE import line and
// ONE entry in PLUGINS below, so tickets never touch the same lines.
// A plugin module exports mount(ctx) and may return a cleanup function.
// ctx = { root, toolbar, getPoll(), setPoll(poll), onVote(listener), onChange(listener) };
// onVote listeners get { option, poll }, onChange listeners get the poll; both return an unsubscribe function.

export const PLUGINS = [];

// One failing plugin must not stop the page; returns a function that unmounts the plugins that started.
export function mountPlugins(ctx) {
  const cleanups = [];
  for (const plugin of PLUGINS) {
    try {
      cleanups.push(plugin.mount(ctx));
    } catch (err) {
      console.error("polls plugin failed to mount", err);
    }
  }
  return () => cleanups.forEach((stop) => stop?.());
}
