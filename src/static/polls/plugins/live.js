// Live results: keeps the tallies in sync with other voters over Server-Sent Events.
export function mount(ctx) {
  const wrapper = document.createElement("div");
  wrapper.className = "poll-tool";
  wrapper.dataset.plugin = "live";
  const status = document.createElement("span");
  status.id = "poll-live";
  status.textContent = "Reconnecting...";
  wrapper.append(status);
  ctx.toolbar.append(wrapper);
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "/static/polls/plugins/live.css";
  document.head.append(style);

  const apply = (event) => {
    const { tallies, total } = JSON.parse(event.data);
    ctx.setPoll({ ...ctx.getPoll(), tallies, total });
  };
  const source = new EventSource(`/api/polls/${encodeURIComponent(ctx.getPoll().id)}/events`);
  source.addEventListener("open", () => {
    status.textContent = "Live";
    status.dataset.state = "live";
  });
  source.addEventListener("error", () => {
    status.textContent = "Reconnecting...";
    status.dataset.state = "reconnecting";
  });
  source.addEventListener("snapshot", apply);
  source.addEventListener("vote", apply);

  return () => {
    source.close();
    wrapper.remove();
    style.remove();
  };
}
