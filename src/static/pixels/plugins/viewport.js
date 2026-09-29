import { createView, clampView, cellAt, panBy, zoomAt, frameFromRect } from "../viewport-math.js";

const DRAG_THRESHOLD = 4;
const HOVER_DEBOUNCE_MS = 300;
const ZOOM_STEP = 1.25;

const STYLE = `
.pixels-viewport { display: block; width: fit-content; overflow: hidden; border: 1px solid #888; line-height: 0; }
.pixels-viewport #pixels { border: 0; transform-origin: 0 0; touch-action: none; cursor: crosshair; }
.pixels-viewport.panning #pixels { cursor: grabbing; }
#pixels-coords { margin: 0; min-height: 1.25rem; font-variant-numeric: tabular-nums; }
`;

export function mount({ board, canvas, toolbar, redraw, view }) {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);

  const frameEl = document.createElement("div");
  frameEl.className = "pixels-viewport";
  canvas.replaceWith(frameEl);
  frameEl.append(canvas);

  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.id = "pixels-reset-view";
  resetButton.textContent = "Reset view";
  toolbar.append(resetButton);

  const coords = document.createElement("p");
  coords.id = "pixels-coords";
  coords.setAttribute("aria-live", "off");
  toolbar.after(coords);

  const frameSize = () => canvas.offsetWidth;
  const frameOrigin = () => frameFromRect(canvas.getBoundingClientRect(), view);

  function apply(next) {
    Object.assign(view, next);
    canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }

  function cellUnder(clientX, clientY) {
    const frame = frameOrigin();
    return cellAt(view, frame.size, board.width, clientX - frame.left, clientY - frame.top);
  }

  // Wheel: zoom around the cursor.
  function onWheel(event) {
    event.preventDefault();
    const frame = frameOrigin();
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    apply(zoomAt(view, frame.size, factor, event.clientX - frame.left, event.clientY - frame.top));
  }

  // Drag: pan. Movement past the threshold makes the gesture a drag, and its click is swallowed.
  let drag = null;
  let swallowClick = false;

  function onPointerDown(event) {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false };
    swallowClick = false;
  }

  function onPointerMove(event) {
    if (drag && drag.id === event.pointerId) {
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= DRAG_THRESHOLD) {
        drag.moved = true;
        frameEl.classList.add("panning");
        canvas.setPointerCapture?.(event.pointerId);
      }
      if (drag.moved) {
        apply(panBy(view, frameSize(), event.clientX - drag.lastX, event.clientY - drag.lastY));
        swallowClick = true;
      }
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
    }
    showCell(cellUnder(event.clientX, event.clientY));
  }

  function endDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    frameEl.classList.remove("panning");
    // The click that follows a drag's pointerup fires synchronously; clear the flag afterwards.
    setTimeout(() => {
      swallowClick = false;
    }, 0);
  }

  function onClickCapture(event) {
    if (event.target !== canvas || !swallowClick) return;
    swallowClick = false;
    event.stopImmediatePropagation();
    event.preventDefault();
  }

  // Hover label: instant coordinates, debounced last-paint time.
  let hoverTimer = null;
  let hoverToken = 0;

  function showCell(cell) {
    clearTimeout(hoverTimer);
    hoverToken++;
    if (!board.inRange(cell.x, cell.y)) {
      coords.textContent = "";
      return;
    }
    coords.textContent = `${cell.x}, ${cell.y}`;
    const token = hoverToken;
    hoverTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/pixels/at?x=${cell.x}&y=${cell.y}`);
        if (!res.ok) return;
        const { updatedAt } = await res.json();
        if (token !== hoverToken) return;
        coords.textContent = `${cell.x}, ${cell.y} · ${updatedAt ? new Date(updatedAt).toLocaleString() : "never"}`;
      } catch {}
    }, HOVER_DEBOUNCE_MS);
  }

  function onLeave() {
    clearTimeout(hoverTimer);
    hoverToken++;
    coords.textContent = "";
  }

  const onReset = () => apply({ scale: 1, x: 0, y: 0 });
  const onResize = () => apply(clampView(view, frameSize()));

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", onLeave);
  window.addEventListener("click", onClickCapture, true);
  window.addEventListener("resize", onResize);
  resetButton.addEventListener("click", onReset);
  apply(view);

  return () => {
    clearTimeout(hoverTimer);
    window.removeEventListener("click", onClickCapture, true);
    window.removeEventListener("resize", onResize);
    frameEl.replaceWith(canvas);
    canvas.style.transform = "";
    resetButton.remove();
    coords.remove();
    style.remove();
  };
}
