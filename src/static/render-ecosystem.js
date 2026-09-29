// Draw code for the ecosystem event effects (see events-ecosystem.js), keyed by effect type.
// Each renderer is fn(ctx2d, effect, world); everything is drawn in world coordinates.
export const ECOSYSTEM_RENDERERS = {
  famine(ctx, e, world) {
    const t = Math.min(e.age / e.duration, 1);
    ctx.strokeStyle = `rgba(200, 150, 60, ${1 - t})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(world.width / 2, world.height / 2, Math.max(world.width, world.height) * t * 0.6, 0, Math.PI * 2);
    ctx.stroke();
  },

  frenzy(ctx, e) {
    ctx.strokeStyle = "rgba(230, 50, 50, 0.7)";
    ctx.lineWidth = 2;
    for (const c of e.victims) {
      if (c.dead) continue;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.radius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  },

  migration(ctx, e) {
    const t = Math.min(e.age / e.duration, 1);
    ctx.strokeStyle = `rgba(90, 170, 255, ${1 - t})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(e.x, e.y, 20 + 60 * t, 0, Math.PI * 2);
    ctx.stroke();
  },
};
