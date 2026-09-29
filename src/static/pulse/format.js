export const RANGES = ["24h", "7d", "30d"];
export const DEFAULT_RANGE = "24h";
export const RANGE_LABELS = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

export function parseRange(value) {
  return RANGES.includes(value) ? value : DEFAULT_RANGE;
}

export function formatCount(n) {
  return n.toLocaleString("en-US");
}

export function viewsPerVisitor(pageviews, visitors) {
  return visitors > 0 ? pageviews / visitors : 0;
}

export function formatRatio(n) {
  return n.toFixed(1);
}

// Change against the previous window as { text, dir }; "—" when there is nothing to compare with.
export function formatDelta(current, previous) {
  if (!previous) return { text: "—", dir: "flat" };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct > 0) return { text: `+${pct}%`, dir: "up" };
  if (pct < 0) return { text: `${pct}%`, dir: "down" };
  return { text: "0%", dir: "flat" };
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key === "text") node.textContent = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  node.append(...children);
  return node;
}
