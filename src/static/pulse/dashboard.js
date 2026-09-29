import { ApiError, getSite, getSummary } from "./api.js";
import { RANGES, RANGE_LABELS, el, formatCount, formatDelta, formatRatio, parseRange, viewsPerVisitor } from "./format.js";
import { mountPlugins } from "./plugins/index.js";

const KPIS = [
  { key: "pageviews", label: "Pageviews", value: (s) => s.pageviews, previous: (s) => s.previous.pageviews, format: formatCount },
  { key: "visitors", label: "Visitors", value: (s) => s.visitors, previous: (s) => s.previous.visitors, format: formatCount },
  {
    key: "views-per-visitor",
    label: "Views per visitor",
    value: (s) => viewsPerVisitor(s.pageviews, s.visitors),
    previous: (s) => viewsPerVisitor(s.previous.pageviews, s.previous.visitors),
    format: formatRatio,
  },
];

function kpiTile(kpi) {
  return el(
    "div",
    { class: "pulse-kpi", "data-kpi": kpi.key },
    el("span", { class: "pulse-kpi-label", text: kpi.label }),
    el("span", { class: "pulse-kpi-value", text: "—" }),
    el("span", { class: "pulse-kpi-delta flat", text: "—" }),
  );
}

function renderKpis(container, summary) {
  for (const kpi of KPIS) {
    const tile = container.querySelector(`[data-kpi="${kpi.key}"]`);
    const delta = formatDelta(kpi.value(summary), kpi.previous(summary));
    tile.querySelector(".pulse-kpi-value").textContent = kpi.format(kpi.value(summary));
    const deltaEl = tile.querySelector(".pulse-kpi-delta");
    deltaEl.textContent = delta.text;
    deltaEl.className = `pulse-kpi-delta ${delta.dir}`;
  }
}

function showNotFound(root, status) {
  root.replaceChildren(el("h1", { text: "Pulse" }), status, el("p", {}, el("a", { href: "/pulse", text: "Back to all sites" })));
}

export async function mountDashboard(root, siteId) {
  const status = el("p", { id: "pulse-status", role: "status", "aria-live": "polite" });
  let site;
  try {
    site = await getSite(siteId);
  } catch (err) {
    status.textContent = err instanceof ApiError && err.status === 404 ? "Site not found" : err.message;
    if (err instanceof ApiError && err.status !== 404) status.classList.add("error");
    showNotFound(root, status);
    return;
  }

  let range = parseRange(new URLSearchParams(location.search).get("range"));
  let summary = null;
  let mounted = false;
  const listeners = new Set();

  const rangeButtons = RANGES.map((r) => el("button", { type: "button", "data-range": r, "aria-pressed": "false", text: RANGE_LABELS[r] }));
  const rangeBar = el("div", { id: "pulse-range", role: "group", "aria-label": "Date range" }, ...rangeButtons);
  const headerTools = el("div", { id: "pulse-header-tools" });
  const kpis = el("div", { id: "pulse-kpis" }, ...KPIS.map(kpiTile));
  const grid = el("div", { id: "pulse-grid" });
  const app = el(
    "div",
    { id: "pulse-app" },
    el(
      "header",
      { class: "pulse-header" },
      el("div", { class: "pulse-header-text" }, el("h1", { id: "pulse-site-title", text: site.name }), site.domain && el("p", { class: "pulse-domain", text: site.domain })),
      el("div", { class: "pulse-header-right" }, headerTools, rangeBar),
    ),
    status,
    kpis,
    grid,
  );
  root.replaceChildren(app);

  function syncRangeButtons() {
    for (const btn of rangeButtons) btn.setAttribute("aria-pressed", String(btn.dataset.range === range));
  }

  function addCard({ name, title, span, order }) {
    const body = el("div", { class: "pulse-card-body" });
    const card = el(
      "section",
      { class: "pulse-card", "data-plugin": name, "data-span": span, "data-order": order },
      el("h2", { class: "pulse-card-title", text: title }),
      body,
    );
    const next = [...grid.children].find((other) => Number(other.dataset.order) > order);
    grid.insertBefore(card, next || null);
    return { card, body };
  }

  // Loads the summary of the selected range; never rejects. Returns true when new data was rendered.
  async function load() {
    const requested = range;
    app.setAttribute("aria-busy", "true");
    try {
      const data = await getSummary(site.id, requested);
      if (requested !== range) return false;
      summary = data;
      status.textContent = "";
      status.classList.remove("error");
      renderKpis(kpis, summary);
      if (!mounted) {
        mounted = true;
        mountPlugins(ctx);
      } else {
        for (const listener of [...listeners]) {
          try {
            listener({ site, range, summary });
          } catch (err) {
            console.error("pulse data listener failed", err);
          }
        }
      }
      return true;
    } catch (err) {
      if (requested === range) {
        status.textContent = `Could not load data: ${err.message}`;
        status.classList.add("error");
      }
      return false;
    } finally {
      if (requested === range) app.setAttribute("aria-busy", "false");
    }
  }

  // While a load is in flight, any number of refresh() calls share exactly one follow-up load.
  let inflight = null;
  let queued = null;
  function refresh() {
    if (!inflight) {
      inflight = load().finally(() => {
        inflight = null;
      });
      return inflight;
    }
    queued ||= inflight.then(() => {
      queued = null;
      return refresh();
    });
    return queued;
  }

  function setRange(next) {
    next = parseRange(next);
    if (next === range) return Promise.resolve();
    range = next;
    const url = new URL(location.href);
    url.searchParams.set("range", range);
    history.replaceState(null, "", url);
    syncRangeButtons();
    return refresh();
  }

  const ctx = {
    site,
    headerTools,
    getRange: () => range,
    getSummary: () => summary,
    onData(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    addCard,
  };

  rangeBar.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-range]");
    if (btn) setRange(btn.dataset.range);
  });

  window.__pulse = {
    site,
    get range() {
      return range;
    },
    get summary() {
      return summary;
    },
    setRange,
    refresh,
    ctx,
  };

  syncRangeButtons();
  await refresh();
}
