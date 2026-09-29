const MAX_ITEMS = 10;
const TICK_MS = 15_000;
const STYLESHEET = "/static/pulse/plugins/live.css";

function node(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") element.textContent = value;
    else element.setAttribute(key, value);
  }
  element.append(...children);
  return element;
}

export function relativeTime(iso, now = Date.now()) {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!(minutes >= 1)) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

export function mount(ctx) {
  const stylesheet = node("link", { rel: "stylesheet", href: STYLESHEET });
  document.head.append(stylesheet);

  const count = node("span", { id: "pulse-live-count", text: "Reconnecting…" });
  const widget = node("div", { id: "pulse-live", class: "offline", role: "status" }, node("span", { class: "pulse-live-dot", "aria-hidden": "true" }), count);
  ctx.headerTools.append(widget);

  const { card, body } = ctx.addCard({ name: "live", title: "Realtime", span: "half", order: 40 });
  const feed = node("ol", { id: "pulse-live-feed" });
  const empty = node("p", { class: "pulse-empty", text: "Waiting for visitors…" });
  body.append(empty, feed);

  function itemFor(hit, isNew) {
    const time = node("time", { class: "pulse-live-time", datetime: hit.at, text: relativeTime(hit.at) });
    return node(
      "li",
      { class: `pulse-live-item${isNew ? " is-new" : ""}` },
      node("span", { class: "pulse-live-path", title: hit.path, text: hit.path }),
      node("span", { class: "pulse-live-device", text: hit.device }),
      time,
    );
  }

  function syncEmpty() {
    empty.hidden = feed.children.length > 0;
  }

  function setActive(active) {
    count.textContent = `${active} online`;
  }

  function setOnline(online) {
    widget.classList.toggle("offline", !online);
    if (!online) count.textContent = "Reconnecting…";
  }

  function tick() {
    for (const time of feed.querySelectorAll("time")) time.textContent = relativeTime(time.getAttribute("datetime"));
  }

  const timer = setInterval(tick, TICK_MS);
  const source = new EventSource(`/api/pulse/sites/${encodeURIComponent(ctx.site.id)}/live`);

  source.addEventListener("open", () => setOnline(true));
  source.addEventListener("error", () => setOnline(false));
  source.addEventListener("snapshot", (event) => {
    const { active, recent } = JSON.parse(event.data);
    setOnline(true);
    setActive(active);
    feed.replaceChildren(...recent.slice(0, MAX_ITEMS).map((hit) => itemFor(hit, false)));
    syncEmpty();
  });
  source.addEventListener("hit", (event) => {
    const { hit, active } = JSON.parse(event.data);
    setActive(active);
    feed.prepend(itemFor(hit, true));
    while (feed.children.length > MAX_ITEMS) feed.lastElementChild.remove();
    syncEmpty();
    ctx.refresh();
  });

  return () => {
    source.close();
    clearInterval(timer);
    widget.remove();
    card.remove();
    stylesheet.remove();
  };
}
