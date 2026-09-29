import { el, formatCount } from "../format.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const DEVICES = ["desktop", "mobile", "tablet", "unknown"];
const NAMES = { desktop: "Desktop", mobile: "Mobile", tablet: "Tablet", unknown: "Unknown" };
const SIZE = 120;
const CENTER = SIZE / 2;
const RADIUS = 46;
const GAP_DEGREES = 3;
const MIN_SWEEP = 0.5;

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

function point(degrees) {
  const rad = ((degrees - 90) * Math.PI) / 180;
  return `${(CENTER + RADIUS * Math.cos(rad)).toFixed(3)} ${(CENTER + RADIUS * Math.sin(rad)).toFixed(3)}`;
}

// A single arc cannot span 360 degrees, so a full ring is drawn as two half circles.
function arcPath(start, end) {
  if (end - start >= 360) {
    return `M ${point(0)} A ${RADIUS} ${RADIUS} 0 1 1 ${point(180)} A ${RADIUS} ${RADIUS} 0 1 1 ${point(0)}`;
  }
  return `M ${point(start)} A ${RADIUS} ${RADIUS} 0 ${end - start > 180 ? 1 : 0} 1 ${point(end)}`;
}

// Rows for the devices that have pageviews, in the fixed display order.
function shownDevices(rows) {
  const counts = new Map(rows.map((row) => [row.key, row.pageviews]));
  return DEVICES.filter((device) => counts.get(device) > 0).map((device, index) => ({ device, count: counts.get(device), series: index }));
}

export function mount(ctx) {
  const link = el("link", { rel: "stylesheet", href: new URL("./devices.css", import.meta.url).href });
  document.head.append(link);
  const { card, body } = ctx.addCard({ name: "devices", title: "Devices", span: "half", order: 30 });

  let requestId = 0;
  let active = null;

  function setActive(device) {
    active = device;
    const layout = body.querySelector(".pulse-devices-layout");
    if (layout) layout.toggleAttribute("data-active", Boolean(device));
    for (const node of body.querySelectorAll("[data-device]")) node.classList.toggle("is-active", node.dataset.device === device);
  }

  function render(rows) {
    const shown = shownDevices(rows);
    if (!shown.length) {
      body.replaceChildren(el("p", { class: "pulse-empty", text: "No data yet" }));
      return;
    }
    const total = shown.reduce((sum, item) => sum + item.count, 0);
    const gap = shown.length > 1 ? GAP_DEGREES : 0;
    let cursor = 0;
    const slices = shown.map(({ device, count }) => {
      const sweep = (count / total) * 360;
      const start = cursor + gap / 2;
      const end = Math.max(cursor + sweep - gap / 2, start + MIN_SWEEP);
      cursor += sweep;
      return svg("path", {
        class: "pulse-device-slice",
        "data-device": device,
        d: arcPath(start, end),
        style: `stroke: var(--pulse-series-${DEVICES.indexOf(device) + 1})`,
      });
    });
    const chart = svg(
      "svg",
      { id: "pulse-devices", viewBox: `0 0 ${SIZE} ${SIZE}`, role: "img", "aria-label": `Pageviews by device, ${formatCount(total)} in total` },
      ...slices,
      svg("text", { class: "pulse-devices-total", x: CENTER, y: CENTER, "text-anchor": "middle" }, formatCount(total)),
      svg("text", { class: "pulse-devices-label", x: CENTER, y: CENTER + 13, "text-anchor": "middle" }, "pageviews"),
    );
    const legend = el(
      "ul",
      { class: "pulse-devices-legend" },
      ...shown.map(({ device, count }) =>
        el(
          "li",
          { class: "pulse-device", "data-device": device, style: `--pulse-device-color: var(--pulse-series-${DEVICES.indexOf(device) + 1})` },
          el("span", { class: "pulse-device-dot", "aria-hidden": "true" }),
          el("span", { class: "pulse-device-name", text: NAMES[device] }),
          el("span", { class: "pulse-device-count", text: formatCount(count) }),
          el("span", { class: "pulse-device-percent", text: `${Math.round((count / total) * 100)}%` }),
        ),
      ),
    );
    body.replaceChildren(el("div", { class: "pulse-devices-layout" }, chart, legend));
    setActive(active && shown.some((item) => item.device === active) ? active : null);
  }

  async function load() {
    const id = ++requestId;
    const params = new URLSearchParams({ by: "device", range: ctx.getRange(), limit: "10" });
    try {
      const res = await fetch(`/api/pulse/sites/${encodeURIComponent(ctx.site.id)}/breakdown?${params}`);
      if (!res.ok) throw new Error(`request failed (${res.status})`);
      const data = await res.json();
      if (id === requestId) render(data.rows);
    } catch (err) {
      if (id === requestId && !body.firstChild) body.replaceChildren(el("p", { class: "pulse-empty", text: "Could not load devices" }));
      console.error("pulse devices failed to load", err);
    }
  }

  const hover = (event) => setActive(event.target.closest?.("[data-device]")?.dataset.device ?? null);
  body.addEventListener("mouseover", hover);
  body.addEventListener("mouseleave", () => setActive(null));

  load();
  const unsubscribe = ctx.onData(load);

  return () => {
    requestId += 1;
    unsubscribe();
    body.removeEventListener("mouseover", hover);
    card.remove();
    link.remove();
  };
}
