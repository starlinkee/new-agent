import {
  addCreature,
  clamp,
  creatureRadius,
  delta,
  kill,
  manageSpecies,
  onReset,
  recordBirth,
  registerSystem,
  wrap,
} from "/static/world-sim.js";

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

export function addPredator(world, props = {}) {
  const t = world.config.species.predator ?? PREDATOR_DEFAULTS;
  return addCreature(world, {
    species: "predator",
    hue: 0,
    speed: t.speed,
    energy: t.startEnergy,
    ...props,
  });
}

// Temporary effects (e.g. the frenzy event) raise `boost`; the base `speed` stays untouched, so offspring inherit
// the unboosted value and an effect's expiry cannot leave a stat stuck at a boosted level.
export function boostOf(p) {
  return p.boost ?? 1;
}

export function effectiveSpeed(p) {
  return p.speed * boostOf(p);
}

export function effectiveVision(world, p) {
  const t = world.config.species?.predator ?? PREDATOR_DEFAULTS;
  return t.predatorVision * boostOf(p);
}

// Fills `out` with the living herbivores, reusing the array between ticks.
function collectPrey(world, out) {
  out.length = 0;
  const creatures = world.creatures;
  for (let i = 0, n = creatures.length; i < n; i++) {
    const c = creatures[i];
    if (c.species === "herbivore" && !c.dead) out.push(c);
  }
}

// Nearest living herbivore within `vision`, or null. Distance is one pass over the herbivores, so a tick costs at
// most maxPredators x maxCreatures checks.
function nearestPrey(world, predator, prey, vision) {
  let best = null;
  let bestDist = vision * vision;
  for (let i = 0, n = prey.length; i < n; i++) {
    const c = prey[i];
    if (c.dead) continue;
    const dx = delta(predator.x, c.x, world.width);
    const dy = delta(predator.y, c.y, world.height);
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

function steer(world, predator, prey, t, dt) {
  if (!prey) {
    predator.turnRate += (world.random() - 0.5) * 2 * dt;
    predator.turnRate = clamp(predator.turnRate, -1.5, 1.5);
    predator.heading = (predator.heading + predator.turnRate * dt) % TAU;
    return;
  }
  const dx = delta(predator.x, prey.x, world.width);
  const dy = delta(predator.y, prey.y, world.height);
  let diff = (Math.atan2(dy, dx) - predator.heading) % TAU;
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

// The parent only pays once the child exists, so a full world costs it nothing.
function splitPredator(world, parent, t) {
  const share = (parent.energy - t.splitCost) / 2;
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
  parent.energy = share;
  recordBirth(world, child);
  return child;
}

const preyBuffer = [];

export function predatorSystem(world, dt) {
  const t = world.config.species.predator;
  const { speedDrain, maxEnergy } = world.config;
  collectPrey(world, preyBuffer);
  let count = 0;
  for (let i = 0, n = world.creatures.length; i < n; i++) {
    const c = world.creatures[i];
    if (c.species === "predator" && !c.dead) count++;
  }

  // Newborns are appended past `n`, so they first act on the next tick.
  for (let i = 0, n = world.creatures.length; i < n; i++) {
    const p = world.creatures[i];
    if (p.species !== "predator" || p.dead) continue;
    const prey = nearestPrey(world, p, preyBuffer, t.predatorVision * boostOf(p));
    steer(world, p, prey, t, dt);
    const speed = effectiveSpeed(p);
    p.x = wrap(p.x + Math.cos(p.heading) * speed * dt, world.width);
    p.y = wrap(p.y + Math.sin(p.heading) * speed * dt, world.height);
    p.age += dt;
    p.energy -= (t.baseDrain + speedDrain * p.speed * p.speed) * dt;
    if (prey && !prey.dead && contact(world, p, prey)) {
      kill(world, prey, "eaten");
      p.energy = Math.min(maxEnergy, p.energy + t.predatorEnergyGain);
    }
    if (p.energy <= 0) {
      kill(world, p, "starved");
      count--;
      continue;
    }
    p.radius = creatureRadius(world, p);
    if (p.energy >= t.splitThreshold && count < t.maxPredators && splitPredator(world, p, t)) {
      count++;
      p.radius = creatureRadius(world, p);
    }
  }
}

function spawnFounders(world) {
  const t = world.config.species.predator;
  let count = 0;
  for (const c of world.creatures) if (c.species === "predator") count++;
  for (; count < Math.min(t.initial, t.maxPredators); count++) {
    if (!addPredator(world)) break;
  }
}

// Idempotent: a second call only updates the tuning, and never registers the system twice.
export function enablePredators(world, opts = {}) {
  // Replace rather than mutate: config.species may be the object shared with DEFAULT_CONFIG.
  const predator = { ...PREDATOR_DEFAULTS, ...world.config.species.predator, ...opts };
  world.config.species = { ...world.config.species, predator };
  if (world.systems.includes(predatorSystem)) return;
  manageSpecies(world, "predator");
  registerSystem(world, predatorSystem);
  onReset(world, spawnFounders);
  spawnFounders(world);
}
