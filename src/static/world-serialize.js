const REQUIRED_CREATURE_NUMBERS = ["id", "x", "y", "heading", "turnRate", "speed", "hue", "energy", "generation", "age"];
const OPTIONAL_CREATURE_NUMBERS = ["radius"];
const CREATURE_NUMBERS = [...REQUIRED_CREATURE_NUMBERS, ...OPTIONAL_CREATURE_NUMBERS];
const MAX_CREATURE_VALUE = 1e6;
const MAX_RADIUS = 50;
// Config keys that bound the simulation: a snapshot may never change them.
const LIMIT_KEYS = new Set(["maxCreatures", "maxFood", "maxPredators"]);
const WORLD_NUMBERS = ["time", "nextId", "births", "deaths"];

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Plain-JSON snapshot of the simulation state. `random`, `systems` and the log are deliberately left out.
export function serializeWorld(world) {
  const creatures = world.creatures.map((c) => {
    const out = {};
    for (const key of CREATURE_NUMBERS) {
      if (isFiniteNumber(c[key])) out[key] = c[key];
    }
    if (typeof c.species === "string") out.species = c.species;
    return out;
  });
  return {
    version: 1,
    time: world.time,
    nextId: world.nextId,
    births: world.births,
    deaths: world.deaths,
    config: { ...world.config },
    creatures,
    food: world.food.map((f) => ({ x: f.x, y: f.y })),
  };
}

function validate(world, data) {
  if (!isObject(data)) throw new Error("Invalid world data: expected an object");
  for (const key of WORLD_NUMBERS) {
    if (!isFiniteNumber(data[key])) throw new Error(`Invalid world data: "${key}" must be a finite number`);
  }
  if (!isObject(data.config)) throw new Error('Invalid world data: "config" must be an object');
  if (!Array.isArray(data.creatures)) throw new Error('Invalid world data: "creatures" must be an array');
  if (!Array.isArray(data.food)) throw new Error('Invalid world data: "food" must be an array');
  validateConfig(data.config, world.config);
  // Entity caps come from the trusted live config, never from the snapshot being validated.
  if (data.creatures.length > world.config.maxCreatures) throw new Error('Invalid world data: too many creatures');
  if (data.food.length > world.config.maxFood) throw new Error('Invalid world data: too much food');
  const maxEnergy = data.config.maxEnergy ?? world.config.maxEnergy;
  const species = isObject(world.config.species) ? world.config.species : {};
  const inWorld = (x, y) => x >= 0 && x <= world.width && y >= 0 && y <= world.height;
  data.creatures.forEach((c, i) => {
    if (!isObject(c)) throw new Error(`Invalid world data: creature ${i} must be an object`);
    for (const key of REQUIRED_CREATURE_NUMBERS) {
      if (!isFiniteNumber(c[key])) throw new Error(`Invalid world data: creature ${i} field "${key}" must be a finite number`);
    }
    if (!inWorld(c.x, c.y)) throw new Error(`Invalid world data: creature ${i} is outside the world`);
    for (const key of ["speed", "age", "generation"]) {
      if (c[key] < 0 || c[key] > MAX_CREATURE_VALUE) throw new Error(`Invalid world data: creature ${i} field "${key}" is out of range`);
    }
    if (Math.abs(c.turnRate) > MAX_CREATURE_VALUE) throw new Error(`Invalid world data: creature ${i} field "turnRate" is out of range`);
    if (c.energy < 0 || c.energy > maxEnergy * 2) throw new Error(`Invalid world data: creature ${i} field "energy" is out of range`);
    if ("radius" in c && (!isFiniteNumber(c.radius) || c.radius <= 0 || c.radius > MAX_RADIUS)) {
      throw new Error(`Invalid world data: creature ${i} field "radius" is out of range`);
    }
    if ("species" in c && (typeof c.species !== "string" || !Object.hasOwn(species, c.species))) {
      throw new Error(`Invalid world data: creature ${i} has unknown species`);
    }
  });
  data.food.forEach((f, i) => {
    if (!isObject(f) || !isFiniteNumber(f.x) || !isFiniteNumber(f.y)) {
      throw new Error(`Invalid world data: food ${i} needs numeric x and y`);
    }
    if (!inWorld(f.x, f.y)) throw new Error(`Invalid world data: food ${i} is outside the world`);
  });
  const ids = new Set();
  let maxId = -Infinity;
  data.creatures.forEach((c, i) => {
    if (ids.has(c.id)) throw new Error(`Invalid world data: creature ${i} repeats id ${c.id}`);
    ids.add(c.id);
    maxId = Math.max(maxId, c.id);
  });
  if (data.nextId <= maxId) throw new Error('Invalid world data: "nextId" must be greater than every creature id');
}

const SAFE_STRING = /^[\w #.,()%-]{0,40}$/;

// Recursively checks `value` against the shape of the live config: every key must already exist with the same
// type, numbers must be finite and non-negative, strings must match SAFE_STRING (colours, names).
function validateLike(value, live, path) {
  if (typeof value === "number" && typeof live === "number" && value > Math.max(100, live * 10)) {
    throw new Error(`Invalid world data: config "${path}" is out of range`);
  }
  if (typeof value !== typeof live || Array.isArray(value) !== Array.isArray(live) || (value === null) !== (live === null)) {
    throw new Error(`Invalid world data: config "${path}" must be a ${Array.isArray(live) ? "array" : typeof live}`);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid world data: config "${path}" is out of range`);
  } else if (typeof value === "string") {
    if (!SAFE_STRING.test(value)) throw new Error(`Invalid world data: config "${path}" has unsafe characters`);
  } else if (Array.isArray(value)) {
    if (value.length > 0 && live.length === 0) throw new Error(`Invalid world data: config "${path}" must be empty`);
    value.forEach((item, i) => validateLike(item, live[0], `${path}[${i}]`));
  } else if (isObject(value)) {
    for (const [key, inner] of Object.entries(value)) {
      if (!Object.hasOwn(live, key)) throw new Error(`Invalid world data: unknown config "${path}.${key}"`);
      validateLike(inner, live[key], `${path}.${key}`);
    }
  }
}

function validateConfig(config, live) {
  for (const [key, value] of Object.entries(config)) {
    if (!Object.hasOwn(live, key)) throw new Error(`Invalid world data: unknown config "${key}"`);
    validateLike(value, live[key], key);
    if (LIMIT_KEYS.has(key) && value !== live[key]) throw new Error(`Invalid world data: config "${key}" cannot be changed by a snapshot`);
    if (key === "maxEnergy" && value === 0) throw new Error(`Invalid world data: config "${key}" is out of range`);
  }
}

// Copies validated config values onto the live objects so nothing that holds `world.config` goes stale.
function assignConfig(live, config) {
  for (const [key, value] of Object.entries(config)) {
    if (isObject(value) && isObject(live[key])) assignConfig(live[key], value);
    else live[key] = value;
  }
}

// Replaces creatures/food/counters in place. Validates first, so bad data never touches the world.
export function restoreWorld(world, data) {
  validate(world, data);
  const maxEnergy = data.config.maxEnergy ?? world.config.maxEnergy;
  const creatures = data.creatures.map((c) => {
    const creature = { plague: 0, dead: false };
    for (const key of CREATURE_NUMBERS) {
      if (isFiniteNumber(c[key])) creature[key] = c[key];
    }
    if (typeof c.species === "string") creature.species = c.species;
    if (!isFiniteNumber(creature.radius)) {
      creature.radius = 3 + (creature.energy / maxEnergy) * 5;
    }
    return creature;
  });
  assignConfig(world.config, data.config);
  world.creatures.length = 0;
  world.creatures.push(...creatures);
  world.food.length = 0;
  for (const f of data.food) world.food.push({ x: f.x, y: f.y });
  world.time = data.time;
  world.nextId = data.nextId;
  world.births = data.births;
  world.deaths = data.deaths;
  world.foodBudget = 0;
  return world;
}
