import { layout } from "./layout.js";

export function renderPollsPage() {
  return layout({
    title: "Polls",
    body: `<h1>Polls</h1>
<div id="polls-root"></div>
<script type="module" src="/static/polls/main.js"></script>`,
    head: `<link rel="stylesheet" href="/static/polls.css">`,
  });
}
