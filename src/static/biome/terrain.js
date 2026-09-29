// Deterministic terrain shared by the mesh and every placement. Scene units, heights in 0..30.
export const MAX_HEIGHT = 30;

export function heightAt(sx, sz) {
  const h =
    15 +
    8 * Math.sin(sx * 0.011 + 0.6) * Math.cos(sz * 0.013 - 0.4) +
    5 * Math.sin(sx * 0.027 + sz * 0.021) +
    2 * Math.cos(sx * 0.061 - sz * 0.053);
  return Math.min(MAX_HEIGHT, Math.max(0, h));
}

// Sim point (origin in a corner) -> scene point on the ground (origin at the world centre).
export function toScene(x, y, width, height) {
  const sx = x - width / 2;
  const sz = y - height / 2;
  return { x: sx, y: heightAt(sx, sz), z: sz };
}

export function toSim(sx, sz, width, height) {
  return { x: sx + width / 2, y: sz + height / 2 };
}
