import { el, formatCount } from "../format.js";

const LIMIT = 8;

const LISTS = [
  { by: "page", id: "pulse-pages", title: "Top pages", order: 20, column: "Page", label: (key) => key },
  { by: "referrer", id: "pulse-referrers", title: "Top sources", order: 21, column: "Source", label: (key) => key ?? "Direct" },
];

function header(column) {
  return el("div", { class: "pulse-sources-head", "aria-hidden": "true" }, el("span", { text: column }), el("span", { text: "Views" }));
}

function renderRows(list, rows, label) {
  const top = rows[0]?.pageviews || 1;
  return rows.map((row) => {
    const text = label(row.key);
    return el(
      "li",
      { class: "pulse-bar-row", "data-key": row.key ?? "", style: `--pulse-bar: ${Math.round((row.pageviews / top) * 100)}%` },
      el("span", { class: "pulse-row-key", title: text, text }),
      el("span", { class: "pulse-row-value", text: formatCount(row.pageviews) }),
    );
  });
}

async function fetchRows(siteId, by, range) {
  const url = `/api/pulse/sites/${encodeURIComponent(siteId)}/breakdown?by=${by}&range=${encodeURIComponent(range)}&limit=${LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return (await res.json()).rows;
}

export function mount(ctx) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./sources.css", import.meta.url).href;
  document.head.append(link);

  const cards = LISTS.map((def) => {
    const { card, body } = ctx.addCard({ name: "sources", title: def.title, span: "half", order: def.order });
    return { def, card, body, request: 0 };
  });

  function load(entry) {
    const { def, body } = entry;
    const range = ctx.getRange();
    const request = ++entry.request;
    fetchRows(ctx.site.id, def.by, range).then(
      (rows) => {
        if (request !== entry.request || range !== ctx.getRange()) return;
        if (!rows.length) {
          body.replaceChildren(el("p", { class: "pulse-empty", text: "No data yet" }));
          return;
        }
        body.replaceChildren(header(def.column), el("ol", { id: def.id, class: "pulse-sources-list" }, ...renderRows(def, rows, def.label)));
      },
      () => {
        if (request !== entry.request || range !== ctx.getRange()) return;
        body.replaceChildren(el("p", { class: "pulse-empty", text: "Could not load" }));
      },
    );
  }

  const loadAll = () => cards.forEach(load);
  loadAll();
  const unsubscribe = ctx.onData(loadAll);

  return () => {
    unsubscribe();
    for (const entry of cards) entry.request = -1;
    cards.forEach(({ card }) => card.remove());
    link.remove();
  };
}
