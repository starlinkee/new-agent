import { layout } from "./layout.js";

export function renderBlobsPage() {
  return layout({
    title: "Blobs",
    body: `<h1>Blobs</h1>
<div id="blobs-root">
  <canvas id="blobs-canvas"></canvas>
  <div id="blobs-hud"></div>
  <form id="blobs-join">
    <div id="blobs-dead" hidden></div>
    <label for="blobs-name">Your name</label>
    <input id="blobs-name" name="name" maxlength="16" autocomplete="off">
    <button id="blobs-play" type="submit">Play</button>
  </form>
</div>
<p id="blobs-status" role="status"></p>
<script type="module" src="/static/blobs/main.js"></script>`,
    head: `<link rel="stylesheet" href="/static/blobs.css">`,
  });
}
