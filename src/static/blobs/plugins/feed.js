const MAX_ITEMS = 5;
const ITEM_MS = 6000;

export function mount(ctx) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/static/blobs/plugins/feed.css";
  document.head.appendChild(link);

  const tool = document.createElement("div");
  tool.className = "blobs-tool";
  tool.dataset.plugin = "feed";
  const list = document.createElement("ul");
  list.id = "blobs-feed";
  tool.appendChild(list);
  ctx.hud.appendChild(tool);

  const timers = new Set();
  // getMe() is already null when the death event arrives, so remember the last id seen
  let myId = null;
  const stopState = ctx.onState(() => {
    myId = ctx.getMe()?.id ?? myId;
  });

  const add = (text, className) => {
    const li = document.createElement("li");
    if (className) li.className = className;
    li.textContent = text;
    list.prepend(li);
    while (list.children.length > MAX_ITEMS) list.lastElementChild.remove();
    const timer = setTimeout(() => {
      timers.delete(timer);
      li.remove();
    }, ITEM_MS);
    timers.add(timer);
  };

  const stopEvents = ctx.onEvent((event) => {
    const me = ctx.getMe()?.id ?? myId;
    if (event.type === "eaten") {
      const { eater, victim } = event;
      const className = eater.id === me ? "mine-kill" : victim.id === me ? "mine-death" : "";
      add(`${eater.name} ate ${victim.name} (${Math.round(victim.mass)})`, className);
    } else if (event.type === "joined" && event.player.bot === false) {
      add(`${event.player.name} joined`, "join");
    }
  });

  return () => {
    stopState();
    stopEvents();
    timers.forEach(clearTimeout);
    timers.clear();
    tool.remove();
    link.remove();
  };
}
