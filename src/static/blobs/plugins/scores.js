const REFRESH_DELAY_MS = 500;

export function mount(ctx) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/static/blobs/plugins/scores.css";
  document.head.append(link);

  const tool = document.createElement("div");
  tool.className = "blobs-tool";
  tool.dataset.plugin = "scores";
  const panel = document.createElement("div");
  panel.id = "blobs-scores";
  const title = document.createElement("h3");
  title.textContent = "Hall of fame";
  const status = document.createElement("p");
  status.className = "blobs-scores-status";
  status.hidden = true;
  const list = document.createElement("ol");
  panel.append(title, status, list);
  tool.append(panel);
  ctx.hud.append(tool);

  let meId = null;
  let timer = null;
  let stopped = false;

  async function refresh() {
    try {
      const res = await fetch("/api/blobs/scores");
      if (!res.ok) throw new Error(`scores ${res.status}`);
      const { top } = await res.json();
      if (stopped) return;
      list.replaceChildren(
        ...top.map((entry) => {
          const item = document.createElement("li");
          const name = document.createElement("span");
          name.className = "blobs-scores-name";
          name.textContent = entry.name;
          const mass = document.createElement("span");
          mass.className = "blobs-scores-mass";
          mass.textContent = String(Math.round(entry.mass));
          item.append(name, mass);
          return item;
        }),
      );
      status.hidden = true;
    } catch {
      if (stopped) return;
      status.textContent = "Scores unavailable";
      status.hidden = false;
    }
  }

  const refreshSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, REFRESH_DELAY_MS);
  };

  const offState = ctx.onState(() => {
    meId = ctx.getMe()?.id ?? meId;
  });
  const offEvent = ctx.onEvent((event) => {
    if (!meId) return;
    if (event.type === "eaten" && event.victim?.id === meId) refreshSoon();
    else if (event.type === "left" && event.player?.id === meId) refreshSoon();
  });

  refresh();

  return () => {
    stopped = true;
    clearTimeout(timer);
    offState();
    offEvent();
    tool.remove();
    link.remove();
  };
}
