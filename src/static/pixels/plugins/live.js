// Live updates: applies pixels painted by other people, streamed over Server-Sent Events.
function showState(el, state) {
  el.textContent = state;
  el.dataset.state = state;
}

export function mount({ board, toolbar, redraw }) {
  const indicator = document.createElement("span");
  indicator.id = "pixels-live";
  indicator.setAttribute("role", "status");
  showState(indicator, "reconnecting");
  toolbar.append(indicator);

  const apply = ({ x, y, color }) => {
    if (!board.inRange(x, y) || !Number.isInteger(color) || color < 0 || color >= board.palette.length) return;
    board.set(x, y, color);
    redraw();
  };

  // Pixels painted while the stream was down (or before it opened) are recovered from a snapshot.
  const resync = async () => {
    try {
      const res = await fetch("/api/pixels", { cache: "no-store" });
      if (!res.ok) return;
      const { pixels } = await res.json();
      if (pixels.length !== board.colors.length) return;
      board.colors.set(Uint8Array.from(pixels, (ch) => parseInt(ch, 16)));
      redraw();
    } catch {}
  };

  const source = new EventSource("/api/pixels/stream");
  source.addEventListener("open", () => {
    showState(indicator, "live");
    resync();
  });
  source.addEventListener("error", () => showState(indicator, "reconnecting"));
  source.addEventListener("pixel", (event) => {
    try {
      apply(JSON.parse(event.data));
    } catch (err) {
      console.error("bad pixel event", err);
    }
  });

  return () => {
    source.close();
    indicator.remove();
  };
}
