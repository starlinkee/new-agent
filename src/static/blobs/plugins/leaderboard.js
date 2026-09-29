const TOP = 10;
const MIN_INTERVAL_MS = 250;

const byMass = (a, b) => b.mass - a.mass || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function row(player, rank, meId) {
  const li = document.createElement("li");
  li.dataset.playerId = player.id;
  if (player.bot) li.classList.add("bot");
  if (player.id === meId) li.classList.add("me");
  const rankEl = document.createElement("span");
  rankEl.className = "rank";
  rankEl.textContent = `#${rank}`;
  const nameEl = document.createElement("span");
  nameEl.className = "name";
  nameEl.textContent = player.name;
  const massEl = document.createElement("span");
  massEl.className = "mass";
  massEl.textContent = String(Math.round(player.mass));
  li.append(rankEl, nameEl, massEl);
  return li;
}

export function mount(ctx) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./leaderboard.css", import.meta.url).href;
  document.head.append(link);

  const tool = document.createElement("div");
  tool.className = "blobs-tool";
  tool.dataset.plugin = "leaderboard";
  const panel = document.createElement("div");
  panel.id = "blobs-leaderboard";
  const title = document.createElement("h2");
  title.textContent = "Leaderboard";
  const list = document.createElement("ol");
  panel.append(title, list);
  tool.append(panel);
  ctx.hud.append(tool);

  let latest = null;
  let lastRender = -Infinity;
  let timer = 0;

  function render() {
    timer = 0;
    lastRender = performance.now();
    if (!latest) return;
    const ranked = [...latest.players].sort(byMass);
    const meId = ctx.getMe()?.id;
    const items = ranked.slice(0, TOP).map((p, i) => row(p, i + 1, meId));
    const myIndex = meId ? ranked.findIndex((p) => p.id === meId) : -1;
    if (myIndex >= TOP) {
      const separator = document.createElement("li");
      separator.className = "separator";
      separator.setAttribute("aria-hidden", "true");
      separator.textContent = "…";
      items.push(separator, row(ranked[myIndex], myIndex + 1, meId));
    }
    list.replaceChildren(...items);
  }

  const stop = ctx.onState((state) => {
    latest = state;
    if (timer) return;
    const wait = lastRender + MIN_INTERVAL_MS - performance.now();
    if (wait <= 0) render();
    else timer = setTimeout(render, wait);
  });

  return () => {
    stop();
    clearTimeout(timer);
    tool.remove();
    link.remove();
  };
}
