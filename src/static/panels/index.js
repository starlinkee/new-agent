// Side-panel registry for /world. Each panel ticket adds exactly ONE import line
// below and ONE entry in PANELS, so tickets never touch the same lines.
// A panel module exports { slot, mount(sectionEl, ctx) }; `slot` is the id of its
// section in #panels (panel-stats, panel-inspector or panel-save).
import * as statsPanel from "/static/panels/stats-panel.js";

export const PANELS = [statsPanel];

// One failing panel must not stop the page; returns a function that unmounts the panels that started.
export function mountPanels(ctx) {
  const cleanups = [];
  for (const panel of PANELS) {
    const section = document.getElementById(panel.slot);
    if (!section) continue;
    try {
      section.hidden = false;
      cleanups.push(panel.mount(section, ctx));
    } catch (err) {
      console.error(`panel ${panel.slot} failed to mount`, err);
    }
  }
  return () => cleanups.forEach((stop) => stop?.());
}
