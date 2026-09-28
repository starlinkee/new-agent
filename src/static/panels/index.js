// Side-panel registry for /world. Each panel ticket adds exactly ONE import line
// below and ONE entry in PANELS, so tickets never touch the same lines.
// A panel module exports { slot, mount(sectionEl, ctx) }; `slot` is the id of its
// section in #panels (panel-stats, panel-inspector or panel-save).

export const PANELS = [];

export function mountPanels(ctx) {
  for (const panel of PANELS) {
    const section = document.getElementById(panel.slot);
    if (!section) continue;
    section.hidden = false;
    panel.mount(section, ctx);
  }
}
