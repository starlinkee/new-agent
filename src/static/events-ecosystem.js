import { addCreature } from "./world-sim.js";

// Ecosystem events (famine, frenzy, migration). Simulation only, no DOM: pass ECOSYSTEM_EVENTS to
// createEvents({ extensions }) to enable them; render-ecosystem.js holds the matching draw code.

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
  // Partial Fisher-Yates via the events RNG: after `target` swaps, the tail of `order` is a uniform random
  // sample of exactly `target` pellets to remove.
  const order = world.food.map((_, i) => i);
  for (let i = order.length - 1; i >= order.length - target && i > 0; i--) {
    const j = Math.floor(ctx.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const doomed = new Set(order.slice(order.length - target));
  world.food = world.food.filter((_, i) => !doomed.has(i));
  ctx.effects.push({ type: "famine", age: 0, duration: famineDuration });
  return { text: `Famine! ${plural(target, "food pellet")} withered`, affected: target };
}

// Overlapping frenzies stack by count, not by multiplying: a predator is boosted while at least one frenzy covers
// it, and `speed` itself is never rewritten (movement reads `boost`, see predators.js).
function frenzy(world, ctx) {
  const { frenzyBoost, frenzyDuration } = settings(ctx);
  const victims = world.creatures.filter((c) => c.species === "predator" && !c.dead);
  for (const c of victims) {
    c.frenzy = (c.frenzy ?? 0) + 1;
    c.boost = 1 + frenzyBoost;
  }
  ctx.effects.push({
    type: "frenzy",
    victims,
    age: 0,
    duration: frenzyDuration,
    expire() {
      for (const c of this.victims) {
        c.frenzy -= 1;
        if (c.frenzy <= 0) {
          delete c.frenzy;
          delete c.boost;
        }
      }
    },
  });
  return { text: `Hunt frenzy! ${plural(victims.length, "predator")} boosted`, affected: victims.length };
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

export const ECOSYSTEM_EVENTS = Object.freeze([
  { type: "famine", handler: famine, defaults: ECOSYSTEM_EVENT_DEFAULTS },
  { type: "frenzy", handler: frenzy, defaults: ECOSYSTEM_EVENT_DEFAULTS },
  { type: "migration", handler: migration, defaults: ECOSYSTEM_EVENT_DEFAULTS },
]);
