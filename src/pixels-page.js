import { layout } from "./layout.js";
import { PALETTE } from "./pixels.js";

export function renderPixelsPage() {
  const swatches = PALETTE.map(
    (color, i) =>
      `<button type="button" class="swatch-btn" data-color="${i}" aria-label="Colour ${i + 1}" aria-pressed="${i === 0}" style="background:${color}"></button>`,
  ).join("\n    ");
  return layout({
    title: "Pixels",
    body: `<h1>Pixels</h1>
<div class="pixels-layout">
  <canvas id="pixels" aria-label="Shared pixel board"></canvas>
  <div class="pixels-side">
    <div id="palette" role="group" aria-label="Palette">
    ${swatches}
    </div>
    <div id="pixels-tools"></div>
    <p id="pixels-status" role="status" aria-live="polite"></p>
  </div>
</div>
<script type="module" src="/static/pixels/main.js"></script>`,
    head: `<link rel="stylesheet" href="/static/pixels.css">`,
  });
}
