// DOM-free screen <-> board transforms. A view is { scale, x, y }: the board fills a square frame
// of `size` px, is magnified by `scale` and translated by (x, y) px inside that frame.
export const MIN_SCALE = 1;
export const MAX_SCALE = 16;

export function createView() {
  return { scale: MIN_SCALE, x: 0, y: 0 };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Keeps the magnified board covering the whole frame.
export function clampView(view, size) {
  const scale = clamp(view.scale, MIN_SCALE, MAX_SCALE);
  const min = size - size * scale;
  return { scale, x: clamp(view.x, min, 0), y: clamp(view.y, min, 0) };
}

// Frame-relative point (px, py) -> fractional board coordinates.
export function screenToBoard(view, size, cells, px, py) {
  return {
    x: (((px - view.x) / view.scale) / size) * cells,
    y: (((py - view.y) / view.scale) / size) * cells,
  };
}

// Fractional board coordinates -> frame-relative point.
export function boardToScreen(view, size, cells, bx, by) {
  return {
    x: ((bx / cells) * size) * view.scale + view.x,
    y: ((by / cells) * size) * view.scale + view.y,
  };
}

// Whole board cell under a frame-relative point (may be out of range).
export function cellAt(view, size, cells, px, py) {
  const p = screenToBoard(view, size, cells, px, py);
  return { x: Math.floor(p.x), y: Math.floor(p.y) };
}

// Multiplies the scale by `factor`, keeping the board point under (px, py) fixed.
export function zoomAt(view, size, factor, px, py) {
  const scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  const ratio = scale / view.scale;
  return clampView({ scale, x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio }, size);
}

export function panBy(view, size, dx, dy) {
  return clampView({ scale: view.scale, x: view.x + dx, y: view.y + dy }, size);
}

// The untransformed frame, recovered from the canvas' current (transformed) client rect.
export function frameFromRect(rect, view) {
  return { left: rect.left - view.x, top: rect.top - view.y, size: rect.width / view.scale };
}
