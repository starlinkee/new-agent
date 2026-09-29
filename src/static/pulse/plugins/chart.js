import { formatCount } from "../format.js";

const NS = "http://www.w3.org/2000/svg";
const MARGIN = { top: 12, right: 14, bottom: 26 };
const GRIDLINES = 4;
const MIN_LABEL_GAP = 52;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text != null) node.textContent = text;
  return node;
}

// Smallest 1 / 2 / 5 x 10^n that is at least `value`.
function niceStep(value) {
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((m) => m * power).find((step) => step >= value);
}

// Four equal gridline steps; the top of the scale is the smallest nice multiple that holds the data (at least 4).
export function yScale(max) {
  const step = niceStep(Math.max(1, max / GRIDLINES));
  return { step, top: step * GRIDLINES };
}

const pad = (n) => String(n).padStart(2, "0");
const dateLabel = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
const hourLabel = (d) => `${pad(d.getUTCHours())}:00`;
const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? "" : "s"}`;

function bucketLabel(range, t) {
  const d = new Date(t);
  return range === "24h" ? `${dateLabel(d)}, ${hourLabel(d)}` : dateLabel(d);
}

// Indices that get an x label, thinned so neighbours are at least MIN_LABEL_GAP px apart.
function labelIndices(range, count, columnWidth) {
  const base = range === "24h" ? 6 : range === "30d" ? 5 : 1;
  let stride = base;
  while (stride * columnWidth < MIN_LABEL_GAP) stride += base;
  const indices = [];
  for (let i = 0; i < count; i++) {
    if (range === "24h" ? i % stride === 0 : (count - 1 - i) % stride === 0) indices.push(i);
  }
  return indices;
}

export function mount(ctx) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./chart.css", import.meta.url).href;
  document.head.append(link);

  const { card, body } = ctx.addCard({ name: "chart", title: "Traffic", span: "full", order: 10 });
  body.classList.add("pulse-chart-body");

  const legend = document.createElement("ul");
  legend.className = "pulse-chart-legend";
  for (const [cls, label] of [["pageviews", "Pageviews"], ["visitors", "Visitors"]]) {
    const item = document.createElement("li");
    item.className = `pulse-chart-legend-item ${cls}`;
    item.textContent = label;
    legend.append(item);
  }
  const stage = document.createElement("div");
  stage.className = "pulse-chart-stage";
  const tooltip = document.createElement("div");
  tooltip.id = "pulse-chart-tooltip";
  tooltip.className = "pulse-chart-tooltip";
  tooltip.hidden = true;
  const empty = document.createElement("p");
  empty.className = "pulse-empty pulse-chart-empty";
  empty.textContent = "No pageviews in this period";
  empty.hidden = true;
  body.append(legend, stage);
  stage.append(tooltip, empty);

  let summary = ctx.getSummary();
  let chart = null; // { svg, geometry, guide, dots } of the current drawing
  let active = null;
  let animate = true;
  let width = 0;

  function drawChart() {
    const series = summary.series;
    const count = series.length;
    const height = width < 600 ? 180 : 240;
    const max = Math.max(0, ...series.map((b) => Math.max(b.pageviews, b.visitors)));
    const scale = yScale(max);
    const left = 12 + 7.5 * formatCount(scale.top).length;
    const plotWidth = Math.max(1, width - left - MARGIN.right);
    const plotHeight = height - MARGIN.top - MARGIN.bottom;
    const column = plotWidth / Math.max(count, 1);
    const xAt = (i) => left + column * (i + 0.5);
    const yAt = (v) => MARGIN.top + plotHeight * (1 - v / scale.top);
    const total = { pageviews: 0, visitors: 0 };
    series.forEach((b) => (total.pageviews += b.pageviews));
    total.visitors = summary.visitors;

    const root = svg("svg", {
      id: "pulse-chart",
      class: animate ? "pulse-chart animate" : "pulse-chart",
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      tabindex: "0",
      role: "img",
      "aria-label": `Traffic over the last ${ctx.getRange()}: ${plural(total.pageviews, "pageview")} from ${plural(total.visitors, "visitor")}. Use the left and right arrow keys to inspect each period.`,
    });

    for (let k = 0; k <= GRIDLINES; k++) {
      const y = yAt(scale.step * k);
      root.append(svg("line", { class: k === 0 ? "pulse-chart-axis" : "pulse-chart-grid", x1: left, x2: width - MARGIN.right, y1: y, y2: y }));
      root.append(svg("text", { class: "pulse-chart-label y", x: left - 8, y: y + 4, "text-anchor": "end" }, formatCount(scale.step * k)));
    }
    for (const i of labelIndices(ctx.getRange(), count, column)) {
      const d = new Date(series[i].t);
      const text = ctx.getRange() === "24h" ? hourLabel(d) : dateLabel(d);
      root.append(svg("text", { class: "pulse-chart-label x", x: xAt(i), y: height - 6, "text-anchor": "middle" }, text));
    }

    const line = (key) => series.map((b, i) => `${i ? "L" : "M"}${xAt(i).toFixed(1)} ${yAt(b[key]).toFixed(1)}`).join("");
    if (count) {
      const base = MARGIN.top + plotHeight;
      root.append(svg("path", { class: "pulse-chart-area", d: `${line("pageviews")}L${xAt(count - 1).toFixed(1)} ${base}L${xAt(0).toFixed(1)} ${base}Z` }));
      root.append(svg("path", { class: "pulse-chart-line pageviews", d: line("pageviews"), pathLength: 1 }));
      root.append(svg("path", { class: "pulse-chart-line visitors", d: line("visitors"), pathLength: 1 }));
    }

    const guide = svg("line", { class: "pulse-chart-guide", y1: MARGIN.top, y2: MARGIN.top + plotHeight, visibility: "hidden" });
    const dots = {
      pageviews: svg("circle", { class: "pulse-chart-dot pageviews", r: 4, visibility: "hidden" }),
      visitors: svg("circle", { class: "pulse-chart-dot visitors", r: 4, visibility: "hidden" }),
    };
    root.append(guide, dots.visitors, dots.pageviews);

    series.forEach((b, i) => {
      root.append(
        svg("rect", {
          class: "pulse-chart-hit",
          x: left + column * i,
          y: MARGIN.top,
          width: column,
          height: plotHeight,
          "data-index": i,
          "data-pageviews": b.pageviews,
          "data-visitors": b.visitors,
        }),
      );
    });

    stage.querySelector("svg")?.remove();
    stage.prepend(root);
    chart = { root, guide, dots, xAt, yAt, height };
    empty.hidden = total.pageviews > 0;
    stage.classList.toggle("is-empty", total.pageviews === 0);
    animate = false;
    highlight(active);
  }

  function highlight(index) {
    active = index;
    const bucket = index == null ? null : summary.series[index];
    if (!chart) return;
    const visibility = bucket ? "visible" : "hidden";
    chart.guide.setAttribute("visibility", visibility);
    chart.dots.pageviews.setAttribute("visibility", visibility);
    chart.dots.visitors.setAttribute("visibility", visibility);
    tooltip.hidden = !bucket;
    if (!bucket) return;
    const x = chart.xAt(index);
    chart.guide.setAttribute("x1", x);
    chart.guide.setAttribute("x2", x);
    chart.dots.pageviews.setAttribute("cx", x);
    chart.dots.pageviews.setAttribute("cy", chart.yAt(bucket.pageviews));
    chart.dots.visitors.setAttribute("cx", x);
    chart.dots.visitors.setAttribute("cy", chart.yAt(bucket.visitors));

    tooltip.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = bucketLabel(ctx.getRange(), bucket.t);
    const views = document.createElement("span");
    views.className = "pageviews";
    views.textContent = plural(bucket.pageviews, "pageview");
    const visitors = document.createElement("span");
    visitors.className = "visitors";
    visitors.textContent = plural(bucket.visitors, "visitor");
    tooltip.append(title, views, visitors);
    const half = tooltip.offsetWidth / 2;
    tooltip.style.left = `${Math.min(Math.max(x, half), width - half)}px`;
    tooltip.style.top = `${MARGIN.top}px`;
  }

  function render() {
    if (width > 0 && summary) drawChart();
  }

  function onPointerOver(event) {
    const hit = event.target.closest?.("rect.pulse-chart-hit");
    if (hit) highlight(Number(hit.dataset.index));
  }
  function onPointerLeave() {
    highlight(null);
  }
  function onKeyDown(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const last = summary.series.length - 1;
    if (last < 0) return;
    event.preventDefault();
    const from = active ?? last;
    const next = active == null && event.key === "ArrowRight" ? last : from + (event.key === "ArrowRight" ? 1 : -1);
    highlight(Math.min(Math.max(next, 0), last));
  }
  function onBlur() {
    highlight(null);
  }

  stage.addEventListener("pointerover", onPointerOver);
  stage.addEventListener("pointerleave", onPointerLeave);
  stage.addEventListener("keydown", onKeyDown);
  stage.addEventListener("focusout", onBlur);

  const observer = new ResizeObserver(() => {
    const next = Math.round(stage.clientWidth);
    if (next === width) return;
    width = next;
    render();
  });
  observer.observe(stage);

  const stopData = ctx.onData((data) => {
    summary = data.summary;
    active = null;
    animate = true;
    render();
  });

  width = Math.round(stage.clientWidth);
  render();

  return () => {
    stopData();
    observer.disconnect();
    stage.removeEventListener("pointerover", onPointerOver);
    stage.removeEventListener("pointerleave", onPointerLeave);
    stage.removeEventListener("keydown", onKeyDown);
    stage.removeEventListener("focusout", onBlur);
    card.remove();
    link.remove();
  };
}
