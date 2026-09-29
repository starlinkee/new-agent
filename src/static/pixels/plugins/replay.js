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
  // Bumped by every start/stop so a stale history fetch never starts a second animation.
  let generation = 0;

  // Capture phase on the canvas itself runs before the board's paint handler.
  const blockPainting = (event) => {
    if (running) event.stopImmediatePropagation();
  };
  canvas.addEventListener("click", blockPainting, true);

  // Paints the whole replayed image, so live redraws between frames cannot leak into the replay.
  function drawReplay(colors) {
    for (let y = 0; y < board.height; y++) {
      for (let x = 0; x < board.width; x++) {
        ctx2d.fillStyle = board.palette[colors[y * board.width + x]];
        ctx2d.fillRect(x, y, 1, 1);
      }
    }
  }

  // Ends the run. The canvas keeps the replayed image unless restoreLive is set;
  // after a completed replay the next live update (or Stop/Replay) hands the canvas back.
  function finish(message, { restoreLive = true } = {}) {
    generation++;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    running = false;
    replayButton.disabled = false;
    stopButton.hidden = true;
    progress.textContent = message;
    if (restoreLive) redraw();
  }

  async function start() {
    const run = ++generation;
    running = true;
    replayButton.disabled = true;
    stopButton.hidden = false;
    progress.textContent = "Loading history…";
    let events;
    try {
      const res = await fetch("/api/pixels/history", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ({ events } = await res.json());
    } catch (err) {
      if (run === generation) finish(`Could not load history: ${err.message}`);
      return;
    }
    if (run !== generation) return;

    const colors = new Uint8Array(board.width * board.height);
    drawReplay(colors);
    const perFrame = Math.max(1, Math.ceil(events.length / (REPLAY_MS / FRAME_MS)));
    let index = 0;
    progress.textContent = `0 / ${events.length}`;
    const step = () => {
      if (run !== generation) return;
      const end = Math.min(events.length, index + perFrame);
      for (; index < end; index++) {
        const { x, y, color } = events[index];
        if (board.inRange(x, y) && color >= 0 && color < board.palette.length) colors[y * board.width + x] = color;
      }
      drawReplay(colors);
      progress.textContent = `${index} / ${events.length}`;
      if (index < events.length) frame = requestAnimationFrame(step);
      else finish(`Replayed ${events.length} / ${events.length}`, { restoreLive: false });
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
