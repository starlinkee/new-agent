import { layout } from "./layout.js";

export function renderWorldPage() {
  return layout({
    title: "World",
    body: `<h1>Living World</h1>
<canvas id="world" style="display:block;width:100%;height:70vh;background:#0b1d2a"></canvas>
<script type="module" src="/static/world.js"></script>`,
  });
}
