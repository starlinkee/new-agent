import { addCreature, creatureRadius, delta, kill, record, registerSystem } from "/static/world-sim.js";

const TAU = Math.PI * 2;

export const PREDATOR_DEFAULTS = {
  initial: 3,
  maxPredators: 15,
  predatorVision: 150,
  predatorEnergyGain: 45,
  startEnergy: 60,
  baseDrain: 1.8, // herbivores pay 0.8
  splitThreshold: 90,
  splitCost: 20,
  steerRate: 5,
  speed: 80, // herbivores start at 20-70, so predators are faster on average
  minSpeed: 45,
  maxSpeed: 140,
  speedMutation: 0.12,
};

function tuning(world) {
  return { ...PREDATOR_DEFAULTS, ...world.config.species.predator };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function wrap(v, size) {
  if (v < 0) return v + size;
  if (v > size) return v - size;
  return v;
}

export function addPredator(world, props = {}) {
  const t = tuning(world);
  return addCreature(world, {
    species: "predator",
    hue: 0,
    speed: t.speed,
    energy: t.startEnergy,
    ...props,
  });
}

function nearestHerbivore(world, predator, vision) {
  let best = null;
  let bestDist = vision * vision;
  for (const c of world.creatures) {
    if (c.dead || c.species !== "herbivore") continue;
    const dx = delta(predator.x, c.x, world.width);
    const dy = delta(predator.y, c.y, world.height);
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      best = { prey: c, dx, dy };
      bestDist = d;
    }
  }
  return best;
}

function steer(world, predator, target, t, dt) {
  if (!target) {
    predator.turnRate += (world.random() - 0.5) * 2 * dt;
    predator.turnRate = clamp(predator.turnRate, -1.5, 1.5);
    predator.heading = (predator.heading + predator.turnRate * dt) % TAU;
    return;
  }
  let diff = (Math.atan2(target.dy, target.dx) - predator.heading) % TAU;
  if (diff > Math.PI) diff -= TAU;
  else if (diff < -Math.PI) diff += TAU;
  const maxTurn = t.steerRate * dt;
  predator.heading = (predator.heading + clamp(diff, -maxTurn, maxTurn)) % TAU;
}

function contact(world, predator, prey) {
  const reach = creatureRadius(world, predator) + creatureRadius(world, prey);
  const dx = delta(predator.x, prey.x, world.width);
  const dy = delta(predator.y, prey.y, world.height);
  return dx * dx + dy * dy <= reach * reach;
}

function splitPredator(world, parent, t) {
  const share = (parent.energy - t.splitCost) / 2;
  parent.energy = share;
  const speed = clamp(parent.speed * (1 + (world.random() * 2 - 1) * t.speedMutation), t.minSpeed, t.maxSpeed);
  const child = addCreature(world, {
    species: "predator",
    x: parent.x,
    y: parent.y,
    heading: world.random() * TAU,
    hue: parent.hue,
    energy: share,
    generation: parent.generation + 1,
    speed,
  });
  if (!child) return null;
  world.births++;
  record(world, { kind: "birth", id: child.id, generation: child.generation, species: "predator" });
  return child;
}

export function predatorSystem(world, dt) {
  const t = tuning(world);
  const { speedDrain, maxEnergy } = world.config;
  let count = world.creatures.filter((c) => c.species === "predator").length;

  for (const p of [...world.creatures]) {
    if (p.species !== "predator" || p.dead) continue;
    const target = nearestHerbivore(world, p, t.predatorVision);
    steer(world, p, target, t, dt);
    p.x = wrap(p.x + Math.cos(p.heading) * p.speed * dt, world.width);
    p.y = wrap(p.y + Math.sin(p.heading) * p.speed * dt, world.height);
    p.age += dt;
    p.energy -= (t.baseDrain + speedDrain * p.speed * p.speed) * dt;
    if (p.energy <= 0) {
      kill(world, p, "starved");
      count--;
      continue;
    }
    if (target && contact(world, p, target.prey)) {
      kill(world, target.prey, "eaten");
      p.energy = Math.min(maxEnergy, p.energy + t.predatorEnergyGain);
    }
    p.radius = creatureRadius(world, p);
    if (p.energy >= t.splitThreshold && count < t.maxPredators && splitPredator(world, p, t)) {
      count++;
      p.radius = creatureRadius(world, p);
    }
  }
  world.creatures = world.creatures.filter((c) => !c.dead);
}

export function enablePredators(world, opts = {}) {
  const { initial, ...overrides } = opts;
  // Replace rather than mutate: config.species may be the object shared with DEFAULT_CONFIG.
  const predator = { ...PREDATOR_DEFAULTS, ...world.config.species.predator, ...overrides };
  if (initial !== undefined) predator.initial = initial;
  world.config.species = { ...world.config.species, predator };
  registerSystem(world, predatorSystem);
  for (let i = 0; i < predator.initial; i++) {
    if (count(world) >= predator.maxPredators) break;
    addPredator(world);
  }
}

function count(world) {
  return world.creatures.filter((c) => c.species === "predator").length;
}
