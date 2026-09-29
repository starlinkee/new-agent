import { parseBoard } from "./board.js";
import { mountPlugins } from "./plugins/index.js";

const canvas = document.getElementById("pixels");
const palette = document.getElementById("palette");
const toolbar = document.getElementById("pixels-tools");
const status = document.getElementById("pixels-status");

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function main() {
  let board;
  try {
    const res = await fetch("/api/pixels");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    board = parseBoard(await res.json());
  } catch (err) {
    setStatus(`Could not load the board: ${err.message}`, true);
    return;
  }

  canvas.width = board.width;
  canvas.height = board.height;
  const ctx2d = canvas.getContext("2d");

  function redraw() {
    for (let y = 0; y < board.height; y++) {
      for (let x = 0; x < board.width; x++) {
        ctx2d.fillStyle = board.colorAt(x, y);
        ctx2d.fillRect(x, y, 1, 1);
      }
    }
  }

  const paintListeners = new Set();
  const onPaint = (listener) => {
    paintListeners.add(listener);
    return () => paintListeners.delete(listener);
  };

  let selected = 0;
  palette.addEventListener("click", (event) => {
    const button = event.target.closest(".swatch-btn");
    if (!button) return;
    selected = Number(button.dataset.color);
    for (const b of palette.querySelectorAll(".swatch-btn")) b.setAttribute("aria-pressed", String(b === button));
  });

  canvas.addEventListener("click", async (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * board.width);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * board.height);
    if (!board.inRange(x, y)) return;
    const color = selected;
    const previous = board.get(x, y);
    board.set(x, y, color);
    redraw();
    try {
      const res = await fetch("/api/pixels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x, y, color }),
      });
      if (!res.ok) {
        let reason = `HTTP ${res.status}`;
        try {
          reason = (await res.json()).error || reason;
        } catch {}
        throw new Error(reason);
      }
      setStatus(`Painted (${x}, ${y})`);
      for (const listener of [...paintListeners]) {
        try {
          listener({ x, y, color });
        } catch (err) {
          console.error("pixels paint listener failed", err);
        }
      }
    } catch (err) {
      board.set(x, y, previous);
      redraw();
      setStatus(`Could not paint (${x}, ${y}): ${err.message}`, true);
    }
  });

  redraw();
  window.__pixels = { board, redraw };
  mountPlugins({ board, canvas, toolbar, redraw, onPaint });
}

main();
