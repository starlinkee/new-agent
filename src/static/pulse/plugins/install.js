import { el } from "../format.js";

const ORDER = 90;

function loadStyles() {
  const link = el("link", { rel: "stylesheet", href: new URL("./install.css", import.meta.url).href });
  document.head.append(link);
  return link;
}

export function mount(ctx) {
  const link = loadStyles();
  const { card, body } = ctx.addCard({ name: "install", title: "Install", span: "full", order: ORDER });
  const snippetText = `<script defer src="${location.origin}/static/pulse/tracker.js" data-site="${ctx.site.id}"></script>`;

  const code = el("code", { id: "pulse-install-snippet", text: snippetText });
  const copy = el("button", { type: "button", id: "pulse-install-copy", text: "Copy" });
  const status = el("p", { id: "pulse-install-status", role: "status" });
  let timer = null;

  function showStatus() {
    const receiving = ctx.getSummary().pageviews > 0;
    status.className = receiving ? "receiving" : "";
    status.textContent = receiving ? "Receiving data" : "Waiting for the first pageview…";
  }

  function flash(text) {
    clearTimeout(timer);
    status.className = "";
    status.textContent = text;
    timer = setTimeout(() => {
      timer = null;
      showStatus();
    }, 2000);
  }

  function selectSnippet() {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(snippetText);
      flash("Copied");
    } catch {
      selectSnippet();
      flash("Press Ctrl+C to copy");
    }
  });

  body.append(
    el("p", { class: "pulse-install-intro" }, "Add this snippet to the ", el("code", { text: "<head>" }), ` of every page on ${ctx.site.domain || "your site"}.`),
    el("pre", { class: "pulse-install-pre" }, code),
    el("div", { class: "pulse-install-footer" }, status, copy),
  );
  showStatus();

  const stop = ctx.onData(() => {
    if (!timer) showStatus();
  });
  return () => {
    clearTimeout(timer);
    stop();
    card.remove();
    link.remove();
  };
}
