const CSS_URL = new URL("./share.css", import.meta.url).href;

const csvField = (value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

function toCsv(poll) {
  const rows = poll.options.map((text, i) => {
    const votes = poll.tallies[i] ?? 0;
    const percent = poll.total > 0 ? (votes / poll.total) * 100 : 0;
    return [text, String(votes), percent.toFixed(1)].map(csvField).join(",");
  });
  return ["option,votes,percent", ...rows].join("\r\n") + "\r\n";
}

export function mount(ctx) {
  const stylesheet = Object.assign(document.createElement("link"), { rel: "stylesheet", href: CSS_URL });
  document.head.append(stylesheet);

  const copyButton = Object.assign(document.createElement("button"), {
    type: "button",
    id: "poll-copy-link",
    textContent: "Copy link",
  });
  const exportButton = Object.assign(document.createElement("button"), {
    type: "button",
    id: "poll-export-csv",
    textContent: "Export CSV",
  });
  const status = Object.assign(document.createElement("span"), { id: "poll-share-status" });
  status.setAttribute("role", "status");
  const wrapper = Object.assign(document.createElement("div"), { className: "poll-tool" });
  wrapper.dataset.plugin = "share";
  wrapper.append(copyButton, exportButton, status);
  ctx.toolbar.append(wrapper);

  const pollUrl = () => `${location.origin}/polls?id=${ctx.getPoll().id}`;

  function showFallback(url) {
    let input = wrapper.querySelector("#poll-share-url");
    if (!input) {
      input = Object.assign(document.createElement("input"), { type: "text", id: "poll-share-url", readOnly: true });
      input.setAttribute("aria-label", "Poll link");
      wrapper.append(input);
    }
    input.value = url;
    input.focus();
    input.select();
  }

  async function copyLink() {
    const url = pollUrl();
    try {
      await navigator.clipboard.writeText(url);
      wrapper.querySelector("#poll-share-url")?.remove();
      status.textContent = "Link copied";
    } catch {
      status.textContent = "";
      showFallback(url);
    }
  }

  function exportCsv() {
    const poll = ctx.getPoll();
    const blob = new Blob([toCsv(poll)], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), { href, download: `poll-${poll.id}.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
  }

  copyButton.addEventListener("click", copyLink);
  exportButton.addEventListener("click", exportCsv);

  return () => {
    wrapper.remove();
    stylesheet.remove();
  };
}
