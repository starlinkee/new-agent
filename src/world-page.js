import { layout } from "./layout.js";

export function renderWorldPage() {
  return layout({
    title: "World",
    body: `<h1>Living World</h1>
<div class="world-hud">
  <span>Population: <b id="pop-count">0</b></span>
  <span>Food: <b id="food-count">0</b></span>
  <span>Max generation: <b id="max-gen">0</b></span>
  <span>Time: <b id="elapsed">0</b>s</span>
  <span class="world-controls">
    <button id="pause" type="button">Pause</button>
    <button type="button" class="speed" data-speed="1" aria-pressed="true">x1</button>
    <button type="button" class="speed" data-speed="2" aria-pressed="false">x2</button>
    <button type="button" class="speed" data-speed="4" aria-pressed="false">x4</button>
    <button id="reset" type="button">Reset world</button>
  </span>
  <button id="trigger-event" type="button">Trigger random event</button>
</div>
<div class="world-layout">
  <canvas id="world"></canvas>
  <aside id="inspector" class="world-inspector">
    <h2>Inspector</h2>
    <p id="inspector-empty">Click a creature to inspect it. Click empty space to drop food; shift+click spawns a creature.</p>
    <dl id="inspector-stats" hidden>
      <dt>Status</dt><dd id="insp-status">alive</dd>
      <dt>Energy</dt><dd id="insp-energy"></dd>
      <dt>Age</dt><dd id="insp-age"></dd>
      <dt>Generation</dt><dd id="insp-gen"></dd>
      <dt>Speed</dt><dd id="insp-speed"></dd>
      <dt>Color</dt><dd><span id="insp-swatch" class="swatch"></span> <span id="insp-color"></span></dd>
    </dl>
  </aside>
</div>
<ol id="ticker" aria-live="polite" style="list-style:none;margin:0.5rem 0 0;padding:0;font:0.9rem monospace"></ol>
<script type="module" src="/static/world.js"></script>
<script type="module" src="/static/hud.js"></script>`,
    head: `<link rel="stylesheet" href="/static/world.css">`,
  });
}
