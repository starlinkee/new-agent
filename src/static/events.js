import { addFood, delta, mulberry32, record, removeCreatures, split } from "./world-sim.js";

export const EVENT_TYPES = ["meteor", "bloom", "plague", "babyboom"];
export const MIN_DELAY = 15;
export const MAX_DELAY = 40;

export const DEFAULTS = {
  meteorRadius: 90,
  meteorDuration: 1.4, // seconds of impact animation
  bloomRadius: 110,
  bloomFood: 30,
  bloomDuration: 2,
  plagueDuration: 20,
  plagueDrain: 4, // energy per second while infected
  plagueMinFraction: 0.3,
  plagueMaxFraction: 0.6,
  babyBoomEnergy: 50, // creatures at least this well-fed reproduce
};

function within(world, x, y, radius) {
  return (c) => {
    const dx = delta(x, c.x, world.width);
    const dy = delta(y, c.y, world.height);
    return dx * dx + dy * dy <= radius * radius;
  };
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const HANDLERS = {
  meteor(world, ctx, opts) {
    const { x = ctx.random() * world.width, y = ctx.random() * world.height, radius = ctx.config.meteorRadius } = opts;
    // The event entry summarises the toll, so the individual deaths stay out of the ticker.
    const hit = removeCreatures(world, within(world, x, y, radius), "meteor", { silent: true });
    ctx.effects.push({ type: "meteor", x, y, radius, age: 0, duration: ctx.config.meteorDuration });
    return { text: `Meteor hit! ${plural(hit.length, "creature")} lost`, affected: hit.length };
  },

  bloom(world, ctx, opts) {
    const { x = ctx.random() * world.width, y = ctx.random() * world.height, radius = ctx.config.bloomRadius } = opts;
    const { bloomFood } = ctx.config;
    for (let i = 0; i < bloomFood; i++) {
      const angle = ctx.random() * Math.PI * 2;
      const dist = Math.sqrt(ctx.random()) * radius;
      const fx = (((x + Math.cos(angle) * dist) % world.width) + world.width) % world.width;
      const fy = (((y + Math.sin(angle) * dist) % world.height) + world.height) % world.height;
      addFood(world, fx, fy);
    }
    ctx.effects.push({ type: "bloom", x, y, radius, age: 0, duration: ctx.config.bloomDuration });
    return { text: `Food bloom! ${bloomFood} pellets sprouted`, affected: bloomFood };
  },

  plague(world, ctx) {
    const { plagueMinFraction, plagueMaxFraction, plagueDuration } = ctx.config;
    const fraction = plagueMinFraction + ctx.random() * (plagueMaxFraction - plagueMinFraction);
    const victims = world.creatures.filter(() => ctx.random() < fraction);
    for (const c of victims) c.plague++;
    ctx.effects.push({
      type: "plague",
      victims,
      age: 0,
      duration: plagueDuration,
      expire() {
        for (const c of this.victims) c.plague--;
      },
    });
    return { text: `Plague! ${plural(victims.length, "creature")} infected`, affected: victims.length };
  },

  babyboom(world, ctx) {
    const { babyBoomEnergy } = ctx.config;
    const parents = world.creatures.filter((c) => c.energy >= babyBoomEnergy);
    let born = 0;
    for (const parent of parents) {
      if (world.creatures.length >= world.config.maxCreatures) break;
      world.creatures.push(split(world, parent));
      born++;
    }
    return { text: `Baby boom! ${plural(born, "creature")} born`, affected: born };
  },
};

// Builds one events instance's handler table from the built-ins plus `extensions`, an array of
// { type, handler, defaults?, override? }. handler(world, ctx, opts) returns { text, affected };
// ctx = { random, config, effects }. An effect with an `expire(world)` method has it called when it times out.
// Extensions are per instance and never touch the module state, so an events object created without them keeps
// the built-in seeded sequence regardless of what else has been imported.
function buildHandlers(extensions) {
  const handlers = { ...HANDLERS };
  const types = [...EVENT_TYPES];
  const defaults = {};
  for (const ext of extensions) {
    const { type, handler, override = false } = ext ?? {};
    if (typeof type !== "string" || !type) throw new TypeError("Event extension needs a non-empty string type");
    if (typeof handler !== "function") throw new TypeError(`Handler for event "${type}" must be a function`);
    if (Object.hasOwn(handlers, type) && !override) {
      throw new Error(`Event type "${type}" is already defined; pass override: true to replace it`);
    }
    handlers[type] = handler;
    if (!types.includes(type)) types.push(type);
    Object.assign(defaults, ext.defaults);
  }
  return { handlers, types, defaults };
}

// Random world events: a seeded scheduler plus the event definitions. No DOM access.
export function createEvents({ seed, random, config, extensions = [] } = {}) {
  const rng = random ?? (seed === undefined ? Math.random : mulberry32(seed));
  const { handlers, types, defaults } = buildHandlers(extensions);
  const ctx = { random: rng, config: { ...DEFAULTS, ...defaults, ...config }, effects: [] };
  // `types` lists what this instance can fire, and what the random scheduler picks from.
  const state = { effects: ctx.effects, timeToNext: 0, types: Object.freeze(types) };

  function schedule() {
    state.timeToNext = MIN_DELAY + rng() * (MAX_DELAY - MIN_DELAY);
  }

  // Fires an event now. `type` defaults to a random one; opts may pin x/y/radius.
  function trigger(world, type = types[Math.floor(rng() * types.length)], opts = {}) {
    if (!types.includes(type)) throw new RangeError(`Unknown event type "${type}"`);
    const result = handlers[type](world, ctx, opts);
    record(world, { kind: "event", type, text: result.text });
    return { type, ...result };
  }

  // Advances the schedule and the running effects; call once per sim step, before step().
  function update(world, dt) {
    for (let i = ctx.effects.length - 1; i >= 0; i--) {
      const effect = ctx.effects[i];
      effect.age += dt;
      if (effect.type === "plague") {
        effect.victims = effect.victims.filter((c) => !c.dead);
        for (const c of effect.victims) c.energy -= ctx.config.plagueDrain * dt;
      }
      if (effect.age >= effect.duration) {
        effect.expire?.(world);
        ctx.effects.splice(i, 1);
      }
    }
    state.timeToNext -= dt;
    if (state.timeToNext > 0) return null;
    schedule();
    return trigger(world);
  }

  schedule();
  return Object.assign(state, { trigger, update });
}
