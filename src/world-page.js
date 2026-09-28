import { layout } from "./layout.js";

export function renderWorldPage() {
  return layout({
    title: "World",
    body: `<h1>Living World</h1>
<canvas id="world" style="display:block;width:100%;height:70vh;background:#0b1d2a"></canvas>
<button id="trigger-event" type="button">Trigger random event</button>
<ol id="ticker" aria-live="polite" style="list-style:none;margin:0.5rem 0 0;padding:0;font:0.9rem monospace"></ol>
<script type="module" src="/static/world.js"></script>`,
  });
}
