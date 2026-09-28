// Population chart panel: one line per species plus food (dashed, secondary scale), and a text summary.
import { speciesOf } from "/static/stats.js";

export const slot = "panel-stats";

const REDRAW_MS = 250; // at most 4 redraws per second
const FOOD_COLOR = "#3ddc6a";
const PAD = { left: 34, right: 34, top: 8, bottom: 18 };

function speciesColor(name, world) {
  const match = /^hue-(\d+)$/.exec(name);
  if (match) return `hsl(${match[1]} 80% 60%)`;
  const sample = world?.creatures.find((c) => speciesOf(c) === name);
  if (sample) return `hsl(${Math.round(sample.hue)} 80% 60%)`;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 60%)`;
}

export function mount(el, ctx) {
  if (!ctx?.stats || !ctx?.world) throw new Error("stats panel requires ctx.stats and ctx.world");
  const chart = document.createElement("canvas");
  chart.id = "pop-chart";
  chart.style.cssText = "display:block;width:100%;height:160px;background:#0b1d2a";
  const summary = document.createElement("p");
  summary.id = "pop-summary";
  summary.style.cssText = "margin:0.25rem 0 0;font:0.9rem monospace";
  el.append(chart, summary);

  const g = chart.getContext("2d");
  const colors = new Map();

  function color(name) {
    if (!colors.has(name)) colors.set(name, speciesColor(name, ctx.world));
    return colors.get(name);
  }

  function updateSummary(series) {
    const latest = series[series.length - 1];
    const counts = latest?.counts ?? {};
    const parts = Object.keys(counts).sort().map((name) => `${name} ${counts[name]}`);
    parts.push(`Food ${latest?.food ?? 0}`);
    if (!latest) parts.unshift("Species 0");
    summary.textContent = parts.join(" · ");
  }

  function line(points, stroke, dash) {
    g.strokeStyle = stroke;
    g.setLineDash(dash);
    g.lineWidth = 1.5;
    g.beginPath();
    points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.stroke();
  }

  function draw() {
    const series = ctx.stats.series;
    updateSummary(series);

    const ratio = window.devicePixelRatio || 1;
    const w = chart.clientWidth;
    const h = chart.clientHeight;
    if (chart.width !== Math.round(w * ratio) || chart.height !== Math.round(h * ratio)) {
      chart.width = Math.round(w * ratio);
      chart.height = Math.round(h * ratio);
    }
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!series.length) return;

    const nameSet = new Set();
    let maxPop = 1;
    let maxFood = 1;
    for (const s of series) {
      for (const name in s.counts) {
        nameSet.add(name);
        if (s.counts[name] > maxPop) maxPop = s.counts[name];
      }
      if (s.food > maxFood) maxFood = s.food;
    }
    const names = [...nameSet].sort();
    const t0 = series[0].time;
    const span = Math.max(series[series.length - 1].time - t0, 1e-6);
    const plotW = w - PAD.left - PAD.right;
    const plotH = h - PAD.top - PAD.bottom;
    const px = (s) => PAD.left + (series.length === 1 ? plotW : ((s.time - t0) / span) * plotW);
    const py = (v, max) => PAD.top + plotH - (v / max) * plotH;

    g.strokeStyle = "#345";
    g.setLineDash([]);
    g.lineWidth = 1;
    g.strokeRect(PAD.left, PAD.top, plotW, plotH);

    for (const name of names) {
      line(series.map((s) => [px(s), py(s.counts[name] ?? 0, maxPop)]), color(name), []);
    }
    line(series.map((s) => [px(s), py(s.food, maxFood)]), FOOD_COLOR, [5, 4]);

    g.setLineDash([]);
    g.fillStyle = "#9ab";
    g.font = "10px monospace";
    g.textBaseline = "top";
    g.textAlign = "right";
    g.fillText(String(maxPop), PAD.left - 4, PAD.top);
    g.textAlign = "left";
    g.fillStyle = FOOD_COLOR;
    g.fillText(String(maxFood), w - PAD.right + 4, PAD.top);
    g.fillStyle = "#9ab";
    g.fillText(`${Math.round(span)}s`, PAD.left, h - PAD.bottom + 4);
    g.textAlign = "right";
    g.fillText(`t=${Math.round(series[series.length - 1].time)}s`, w - PAD.right, h - PAD.bottom + 4);
  }

  let timer = 0;
  function tick() {
    draw();
    timer = setTimeout(tick, REDRAW_MS);
  }
  tick();

  return () => clearTimeout(timer);
}
