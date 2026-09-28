export const CREATURE_COUNT = 20;
const TAU = Math.PI * 2;

export const DEFAULT_CONFIG = {
  maxEnergy: 100,
  startEnergy: 60,
  baseDrain: 0.8, // energy per second just for being alive
  speedDrain: 0.0004, // extra energy per second, times speed squared
  foodEnergy: 25,
  foodSpawnRate: 4, // pellets per second
  maxFood: 60,
  foodRadius: 3,
  visionRadius: 90,
  steerRate: 4, // radians per second toward food
  splitThreshold: 80,
  splitCost: 10, // energy lost in the act of splitting; the rest is shared with the child
  hueMutation: 14, // degrees, +/-
  speedMutation: 0.12, // fraction, +/-
  minSpeed: 15,
  maxSpeed: 110,
  maxCreatures: 80,
  founders: 5, // respawned when the population dies out
  respawn: true,
};

// Small, fast, seedable PRNG so a world can be replayed exactly.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LOG_LIMIT = 200;

// Appends to the world's feed of things that happened; a UI drains it, headless runs just keep the tail.
export function record(world, entry) {
  world.log.push({ time: world.time, ...entry });
  if (world.log.length > LOG_LIMIT) world.log.shift();
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function creatureRadius(world, c) {
  return 3 + (c.energy / world.config.maxEnergy) * 5;
}

function makeCreature(world, props) {
  const { random, width, height, config } = world;
  const c = {
    x: random() * width,
    y: random() * height,
    heading: random() * TAU,
    turnRate: (random() - 0.5) * 1.2,
    speed: 20 + random() * 50,
    hue: Math.floor(random() * 360),
    energy: config.startEnergy,
    id: world.nextId++,
    plague: 0, // number of active plagues infecting this creature
    dead: false,
    generation: 0,
    age: 0,
    ...props,
  };
  c.radius = creatureRadius(world, c);
  return c;
}

// The one place a creature dies: flags it, counts it and (unless silent) logs it. Callers drop it from world.creatures.
export function kill(world, c, cause = "starved", { silent = false } = {}) {
  c.dead = true;
  world.deaths++;
  if (!silent) record(world, { kind: "death", id: c.id, generation: c.generation, cause });
}

export function removeCreatures(world, predicate, cause, options) {
  const removed = world.creatures.filter(predicate);
  if (removed.length === 0) return removed;
  world.creatures = world.creatures.filter((c) => !predicate(c));
  for (const c of removed) kill(world, c, cause, options);
  return removed;
}

// Manual additions respect the same caps as the automatic paths, so clicking cannot grow the world unboundedly.
// Returns null when the world is full.
export function addCreature(world, props = {}) {
  if (world.creatures.length >= world.config.maxCreatures) return null;
  const c = makeCreature(world, props);
  world.creatures.push(c);
  return c;
}

export function addFood(world, x = world.random() * world.width, y = world.random() * world.height) {
  if (world.food.length >= world.config.maxFood) return null;
  const pellet = { x, y };
  world.food.push(pellet);
  return pellet;
}

export function createWorld({ width = 800, height = 600, count = CREATURE_COUNT, seed, random, config } = {}) {
  const rng = random ?? (seed === undefined ? Math.random : mulberry32(seed));
  const world = {
    width,
    height,
    random: rng,
    config: { ...DEFAULT_CONFIG, ...config },
    creatures: [],
    food: [],
    foodBudget: 0,
    time: 0,
    nextId: 1,
    log: [],
    births: 0,
    deaths: 0,
    respawns: 0,
  };
  for (let i = 0; i < count; i++) addCreature(world);
  return world;
}

// Restores the initial state in place. The world keeps its dimensions, config and random source, so a
// seeded world replays from wherever its generator currently is and an unseeded one stays unseeded.
export function resetWorld(world, count = CREATURE_COUNT) {
  world.creatures = [];
  world.food = [];
  world.foodBudget = 0;
  world.time = 0;
  world.births = 0;
  world.deaths = 0;
  world.respawns = 0;
  world.log = [];
  for (let i = 0; i < count; i++) addCreature(world);
}

export function resizeWorld(world, width, height) {
  world.width = width;
  world.height = height;
  for (const c of world.creatures) {
    c.x = clamp(c.x, 0, width);
    c.y = clamp(c.y, 0, height);
  }
  for (const f of world.food) {
    f.x = clamp(f.x, 0, width);
    f.y = clamp(f.y, 0, height);
  }
}

function wrap(v, size) {
  if (v < 0) return v + size;
  if (v > size) return v - size;
  return v;
}

// Shortest signed offset between two coordinates on the wrapping world.
export function delta(a, b, size) {
  let d = b - a;
  if (d > size / 2) d -= size;
  else if (d < -size / 2) d += size;
  return d;
}

function spawnFood(world, dt) {
  const { foodSpawnRate, maxFood } = world.config;
  world.foodBudget += foodSpawnRate * dt;
  while (world.foodBudget >= 1) {
    world.foodBudget -= 1;
    if (world.food.length < maxFood) addFood(world);
  }
}

function nearestFood(world, c) {
  const { visionRadius } = world.config;
  let best = -1;
  let bestDist = visionRadius * visionRadius;
  let bestDx = 0;
  let bestDy = 0;
  for (let i = 0; i < world.food.length; i++) {
    const dx = delta(c.x, world.food[i].x, world.width);
    const dy = delta(c.y, world.food[i].y, world.height);
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      best = i;
      bestDist = d;
      bestDx = dx;
      bestDy = dy;
    }
  }
  return { index: best, dx: bestDx, dy: bestDy, dist: Math.sqrt(bestDist) };
}

function steer(world, c, dt) {
  const target = nearestFood(world, c);
  if (target.index < 0) {
    // Nothing in sight: the turn rate drifts randomly, so the heading changes slowly and smoothly.
    c.turnRate += (world.random() - 0.5) * 2 * dt;
    c.turnRate = clamp(c.turnRate, -1.5, 1.5);
    c.heading = (c.heading + c.turnRate * dt) % TAU;
    return;
  }
  const want = Math.atan2(target.dy, target.dx);
  let diff = (want - c.heading) % TAU;
  if (diff > Math.PI) diff -= TAU;
  else if (diff < -Math.PI) diff += TAU;
  const maxTurn = world.config.steerRate * dt;
  c.heading = (c.heading + clamp(diff, -maxTurn, maxTurn)) % TAU;
}

function eat(world, c) {
  const reach = creatureRadius(world, c) + world.config.foodRadius;
  for (let i = world.food.length - 1; i >= 0; i--) {
    const dx = delta(c.x, world.food[i].x, world.width);
    const dy = delta(c.y, world.food[i].y, world.height);
    if (dx * dx + dy * dy <= reach * reach) {
      world.food.splice(i, 1);
      c.energy = Math.min(world.config.maxEnergy, c.energy + world.config.foodEnergy);
      if (c.energy >= world.config.splitThreshold) break;
    }
  }
}

function mutate(world, parent) {
  const { hueMutation, speedMutation, minSpeed, maxSpeed } = world.config;
  const r = world.random;
  return {
    hue: (parent.hue + (r() * 2 - 1) * hueMutation + 360) % 360,
    speed: clamp(parent.speed * (1 + (r() * 2 - 1) * speedMutation), minSpeed, maxSpeed),
  };
}

export function split(world, parent) {
  const { splitCost } = world.config;
  const share = (parent.energy - splitCost) / 2;
  parent.energy = share;
  const child = makeCreature(world, {
    x: parent.x,
    y: parent.y,
    heading: world.random() * TAU,
    energy: share,
    generation: parent.generation + 1,
    ...mutate(world, parent),
  });
  world.births++;
  record(world, { kind: "birth", id: child.id, generation: child.generation });
  return child;
}

export function step(world, dt) {
  const { baseDrain, speedDrain, splitThreshold, maxCreatures, respawn, founders } = world.config;
  world.time += dt;
  spawnFood(world, dt);

  const born = [];
  const survivors = [];
  for (const c of world.creatures) {
    steer(world, c, dt);
    c.x = wrap(c.x + Math.cos(c.heading) * c.speed * dt, world.width);
    c.y = wrap(c.y + Math.sin(c.heading) * c.speed * dt, world.height);
    c.age += dt;
    c.energy -= (baseDrain + speedDrain * c.speed * c.speed) * dt;
    if (c.energy <= 0) {
      kill(world, c, c.plague > 0 ? "plague" : "starved");
      continue;
    }
    eat(world, c);
    c.radius = creatureRadius(world, c);
    survivors.push(c);
    if (c.energy >= splitThreshold && survivors.length + born.length < maxCreatures) {
      born.push(split(world, c));
      c.radius = creatureRadius(world, c);
    }
  }
  world.creatures = survivors.concat(born);

  if (respawn && world.creatures.length === 0) {
    world.respawns++;
    for (let i = 0; i < founders; i++) addCreature(world);
  }
}
