import { layout } from "./layout.js";

export function renderPulsePage() {
  return layout({
    title: "Pulse",
    body: `<div id="pulse-root"></div>
<script type="module" src="/static/pulse/main.js"></script>`,
    head: `<link rel="stylesheet" href="/static/pulse/pulse.css">`,
  });
}
