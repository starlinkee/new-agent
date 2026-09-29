import { layout } from "./layout.js";

const IMPORT_MAP = {
  imports: {
    three: "/vendor/three/build/three.module.min.js",
    "three/addons/": "/vendor/three/addons/",
  },
};

export function renderBiomePage() {
  return layout({
    title: "Biome",
    body: `<h1>Biome</h1>
<div id="biome-root">
  <canvas id="biome-canvas"></canvas>
  <div id="biome-hud">
    <form id="biome-name-form">
      <input id="biome-name" name="name" maxlength="16" autocomplete="off" aria-label="Your name">
      <button id="biome-rename" type="submit">Rename</button>
    </form>
  </div>
</div>
<p id="biome-status" role="status"></p>
<script type="module" src="/static/biome/main.js"></script>`,
    head: `<link rel="stylesheet" href="/static/biome.css">
    <script type="importmap">${JSON.stringify(IMPORT_MAP)}</script>`,
  });
}
