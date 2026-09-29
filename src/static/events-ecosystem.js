import { addCreature } from "./world-sim.js";
import { registerEvent } from "./events.js";

export const ECOSYSTEM_EVENT_DEFAULTS = {
  famineFraction: 0.6, // share of food pellets that vanish
  famineDuration: 2, // seconds of effect ring
  frenzyBoost: 0.5, // +50% predator speed and vision
  frenzyDuration: 12,
  migrationSize: 6,
  migrationDuration: 2,
};

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function settings(ctx) {
  return { ...ECOSYSTEM_EVENT_DEFAULTS, ...ctx.config };
}

function famine(world, ctx) {
  const { famineFraction, famineDuration } = settings(ctx);
  const before = world.food.length;
  const target = Math.round(before * famineFraction);
  // Partial Fisher-Yates via the events RNG picks exactly `target` pellets to remove.
  const order = world.food.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const doomed = new Set(order.slice(0, target));
  world.food = world.food.filter((_, i) => !doomed.has(i));
  ctx.effects.push({ type: "famine", age: 0, duration: famineDuration });
  return { text: `Famine! ${plural(target, "food pellet")} withered`, affected: target };
}

function frenzy(world, ctx) {
  const { frenzyBoost, frenzyDuration } = settings(ctx);
  const saved = new Map();
  for (const c of world.creatures) {
    if (c.species !== "predator") continue;
    saved.set(c, { speed: c.speed, vision: c.vision });
    c.speed *= 1 + frenzyBoost;
    c.vision = (c.vision ?? world.config.visionRadius) * (1 + frenzyBoost);
  }
  ctx.effects.push({
    type: "frenzy",
    victims: [...saved.keys()],
    age: 0,
    duration: frenzyDuration,
    expire() {
      for (const [c, before] of saved) {
        c.speed = before.speed;
        if (before.vision === undefined) delete c.vision;
        else c.vision = before.vision;
      }
    },
  });
  return { text: `Hunt frenzy! ${plural(saved.size, "predator")} boosted`, affected: saved.size };
}

function migration(world, ctx) {
  const { migrationSize, migrationDuration } = settings(ctx);
  const side = Math.floor(ctx.random() * 4); // 0 left, 1 right, 2 top, 3 bottom
  const along = ctx.random();
  const x = side === 0 ? 0 : side === 1 ? world.width : along * world.width;
  const y = side === 2 ? 0 : side === 3 ? world.height : along * world.height;
  let arrived = 0;
  for (let i = 0; i < migrationSize; i++) {
    const jx = (ctx.random() - 0.5) * 30;
    const jy = (ctx.random() - 0.5) * 30;
    const c = addCreature(world, {
      x: Math.min(Math.max(x + jx, 0), world.width),
      y: Math.min(Math.max(y + jy, 0), world.height),
      species: "herbivore",
    });
    if (c) arrived++;
  }
  ctx.effects.push({ type: "migration", x, y, age: 0, duration: migrationDuration });
  return { text: `Migration! ${plural(arrived, "herbivore")} arrived`, affected: arrived };
}

registerEvent("famine", famine);
registerEvent("frenzy", frenzy);
registerEvent("migration", migration);

// Draw code for the effects above; world.js calls it for any effect type it does not know.
export function drawEcosystemEffect(ctx, e) {
  const t = Math.min(e.age / e.duration, 1);
  if (e.type === "famine") {
    ctx.strokeStyle = `rgba(200, 150, 60, ${1 - t})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(ctx.canvas.clientWidth / 2, ctx.canvas.clientHeight / 2, Math.max(ctx.canvas.clientWidth, ctx.canvas.clientHeight) * t * 0.6, 0, Math.PI * 2);
    ctx.stroke();
  } else if (e.type === "frenzy") {
    ctx.strokeStyle = "rgba(230, 50, 50, 0.7)";
    ctx.lineWidth = 2;
    for (const c of e.victims) {
      if (c.dead) continue;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.radius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (e.type === "migration") {
    ctx.strokeStyle = `rgba(90, 170, 255, ${1 - t})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(e.x, e.y, 20 + 60 * t, 0, Math.PI * 2);
    ctx.stroke();
  }
}
