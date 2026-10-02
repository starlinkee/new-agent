import { layout } from "./layout.js";

export function renderMeetPage() {
  return layout({
    title: "Meet",
    body: `<h1>Meet</h1>
<div id="meet-root"></div>
<script type="module" src="/static/meet/main.js"></script>`,
    head: `<link rel="stylesheet" href="/static/meet.css">`,
  });
}
