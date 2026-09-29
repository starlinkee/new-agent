const CSS_URL = new URL("./activity.css", import.meta.url).href;
const SVG_NS = "http://www.w3.org/2000/svg";
const MIN_INTERVAL_MS = 1000;
const CHART_WIDTH = 300;
const CHART_HEIGHT = 80;
const BUCKET_CHOICES = [
  [10, "10 s"],
  [60, "1 min"],
  [600, "10 min"],
];

const votesLabel = (n) => `${n} ${n === 1 ? "vote" : "votes"}`;

export function mount(ctx) {
  const stylesheet = Object.assign(document.createElement("link"), { rel: "stylesheet", href: CSS_URL });
  document.head.append(stylesheet);

  const select = Object.assign(document.createElement("select"), { id: "poll-activity-bucket" });
  select.setAttribute("aria-label", "Bucket size");
  for (const [sec, text] of BUCKET_CHOICES) {
    select.append(Object.assign(document.createElement("option"), { value: String(sec), textContent: text }));
  }
  select.value = "60";

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.id = "poll-activity";
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Votes over time");
  svg.setAttribute("viewBox", `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);
  svg.setAttribute("preserveAspectRatio", "none");

  const empty = Object.assign(document.createElement("p"), { className: "activity-empty", textContent: "No votes yet" });
  const wrapper = Object.assign(document.createElement("div"), { className: "poll-tool" });
  wrapper.dataset.plugin = "activity";
  wrapper.append(select, svg, empty);
  ctx.root.append(wrapper);

  function draw(buckets) {
    empty.hidden = buckets.length > 0;
    svg.hidden = buckets.length === 0;
    const peak = Math.max(1, ...buckets.map((b) => b.votes));
    const slot = CHART_WIDTH / Math.max(buckets.length, 1);
    const bars = buckets.map((bucket, i) => {
      const height = (bucket.votes / peak) * CHART_HEIGHT;
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("class", "activity-bar");
      rect.setAttribute("x", String(i * slot + slot * 0.1));
      rect.setAttribute("width", String(slot * 0.8));
      rect.setAttribute("y", String(CHART_HEIGHT - height));
      rect.setAttribute("height", String(height));
      const title = document.createElementNS(SVG_NS, "title");
      title.textContent = votesLabel(bucket.votes);
      rect.append(title);
      return rect;
    });
    svg.replaceChildren(...bars);
  }

  let disposed = false;
  let requestSeq = 0;
  let lastFetch = 0;
  let timer = null;

  async function load() {
    const seq = ++requestSeq;
    lastFetch = Date.now();
    try {
      const res = await fetch(`/api/polls/${encodeURIComponent(ctx.getPoll().id)}/activity?bucket=${select.value}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!disposed && seq === requestSeq) draw(data.buckets);
    } catch (err) {
      console.error("poll activity failed to load", err);
    }
  }

  // At most one fetch per second: a request inside the window is deferred to its end.
  function refresh() {
    if (timer !== null || disposed) return;
    const wait = Math.max(0, lastFetch + MIN_INTERVAL_MS - Date.now());
    timer = setTimeout(() => {
      timer = null;
      load();
    }, wait);
  }

  const stopVote = ctx.onVote(refresh);
  const stopChange = ctx.onChange(refresh);
  select.addEventListener("change", refresh);
  draw([]);
  load();

  return () => {
    disposed = true;
    clearTimeout(timer);
    stopVote();
    stopChange();
    wrapper.remove();
    stylesheet.remove();
  };
}
