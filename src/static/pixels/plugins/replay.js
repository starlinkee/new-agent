// Replays the paint history on a blank board in about REPLAY_MS, whatever its length.
const REPLAY_MS = 5000;
const FRAME_MS = 1000 / 60;

export function mount({ board, canvas, toolbar, redraw }) {
  const replayButton = document.createElement("button");
  replayButton.type = "button";
  replayButton.id = "pixels-replay";
  replayButton.textContent = "Replay";
  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.id = "pixels-replay-stop";
  stopButton.textContent = "Stop";
  stopButton.hidden = true;
  const progress = document.createElement("span");
  progress.id = "pixels-replay-progress";
  progress.setAttribute("role", "status");
  toolbar.append(replayButton, stopButton, progress);

  const ctx2d = canvas.getContext("2d");
  let frame = null;
  let running = false;

  // Capture phase on the canvas itself runs before the board's paint handler.
  const blockPainting = (event) => {
    if (running) event.stopImmediatePropagation();
  };
  canvas.addEventListener("click", blockPainting, true);

  function finish(message) {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    running = false;
    replayButton.disabled = false;
    stopButton.hidden = true;
    progress.textContent = message;
    redraw();
  }

  async function start() {
    running = true;
    replayButton.disabled = true;
    stopButton.hidden = false;
    progress.textContent = "Loading history…";
    let events;
    try {
      const res = await fetch("/api/pixels/history");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ({ events } = await res.json());
    } catch (err) {
      if (running) finish(`Could not load history: ${err.message}`);
      return;
    }
    if (!running) return;

    ctx2d.fillStyle = board.palette[0];
    ctx2d.fillRect(0, 0, board.width, board.height);
    const perFrame = Math.max(1, Math.ceil(events.length / (REPLAY_MS / FRAME_MS)));
    let index = 0;
    progress.textContent = `0 / ${events.length}`;
    const step = () => {
      const end = Math.min(events.length, index + perFrame);
      for (; index < end; index++) {
        const { x, y, color } = events[index];
        ctx2d.fillStyle = board.palette[color];
        ctx2d.fillRect(x, y, 1, 1);
      }
      progress.textContent = `${index} / ${events.length}`;
      if (index < events.length) frame = requestAnimationFrame(step);
      else finish(`Replayed ${events.length} / ${events.length}`);
    };
    frame = requestAnimationFrame(step);
  }

  replayButton.addEventListener("click", start);
  stopButton.addEventListener("click", () => finish("Stopped"));

  return () => {
    canvas.removeEventListener("click", blockPainting, true);
    if (running) finish("");
    replayButton.remove();
    stopButton.remove();
    progress.remove();
  };
}
