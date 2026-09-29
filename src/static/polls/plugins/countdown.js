const pad = (n) => String(n).padStart(2, "0");

function formatRemaining(ms) {
  const total = Math.ceil(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function mount(ctx) {
  const closesAt = ctx.getPoll().closesAt;
  if (closesAt === null || closesAt === undefined) return undefined;
  const deadline = Date.parse(closesAt);

  const label = document.createElement("span");
  label.id = "poll-countdown";
  const wrapper = document.createElement("div");
  wrapper.className = "poll-tool";
  wrapper.dataset.plugin = "countdown";
  wrapper.append(label);
  ctx.toolbar.append(wrapper);

  let timer = null;
  function tick() {
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      label.textContent = `Closes in ${formatRemaining(remaining)}`;
      return;
    }
    label.textContent = "Closed";
    clearInterval(timer);
    timer = null;
    return true;
  }

  // A poll already past its deadline on load is rendered closed by the page; only a live expiry needs a re-render.
  const alreadyClosed = deadline <= Date.now();
  tick();
  if (!alreadyClosed) {
    timer = setInterval(() => {
      if (tick()) ctx.setPoll({ ...ctx.getPoll() });
    }, 1000);
  }

  return () => {
    clearInterval(timer);
    wrapper.remove();
  };
}
