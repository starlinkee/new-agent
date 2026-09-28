export const CREATURE_COUNT = 20;
const TAU = Math.PI * 2;

export function createWorld({ width = 800, height = 600, count = CREATURE_COUNT, random = Math.random } = {}) {
  const creatures = [];
  for (let i = 0; i < count; i++) {
    creatures.push({
      x: random() * width,
      y: random() * height,
      heading: random() * TAU,
      turnRate: (random() - 0.5) * 1.2,
      speed: 20 + random() * 50,
      radius: 4 + random() * 4,
      hue: Math.floor(random() * 360),
    });
  }
  return { width, height, random, creatures };
}

export function resizeWorld(world, width, height) {
  world.width = width;
  world.height = height;
  for (const c of world.creatures) {
    c.x = Math.min(Math.max(c.x, 0), width);
    c.y = Math.min(Math.max(c.y, 0), height);
  }
}

export function step(world, dt) {
  for (const c of world.creatures) {
    // The turn rate drifts randomly, so the heading changes slowly and smoothly.
    c.turnRate += (world.random() - 0.5) * 2 * dt;
    c.turnRate = Math.max(-1.5, Math.min(1.5, c.turnRate));
    c.heading = (c.heading + c.turnRate * dt) % TAU;
    c.x += Math.cos(c.heading) * c.speed * dt;
    c.y += Math.sin(c.heading) * c.speed * dt;
    if (c.x < 0) c.x += world.width;
    else if (c.x > world.width) c.x -= world.width;
    if (c.y < 0) c.y += world.height;
    else if (c.y > world.height) c.y -= world.height;
  }
}
