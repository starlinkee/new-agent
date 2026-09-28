// Population statistics: samples a world at a fixed simulated-time interval into a ring buffer. DOM-free.
const HUE_BAND = 60; // degrees; creatures without an explicit species are grouped by hue band

export function speciesOf(c) {
  return c.species ?? `hue-${Math.floor(c.hue / HUE_BAND) * HUE_BAND}`;
}

export function createStats({ interval = 1, capacity = 300 } = {}) {
  const series = [];
  let lastTime = null;

  function sample(world) {
    const counts = {};
    let energy = 0;
    for (const c of world.creatures) {
      const key = speciesOf(c);
      counts[key] = (counts[key] ?? 0) + 1;
      energy += c.energy;
    }
    const n = world.creatures.length;
    const entry = {
      time: world.time,
      counts,
      food: world.food.length,
      avgEnergy: n ? energy / n : 0,
      births: world.births,
      deaths: world.deaths,
    };
    series.push(entry);
    if (series.length > capacity) series.shift();
    lastTime = world.time;
    return entry;
  }

  // Safe to call every frame. A world whose clock went backwards (reset) starts a fresh series.
  function maybeSample(world) {
    if (lastTime !== null && world.time < lastTime) {
      series.length = 0;
      lastTime = null;
    }
    if (lastTime === null || world.time - lastTime >= interval) return sample(world);
    return null;
  }

  return { sample, maybeSample, series, latest: () => series[series.length - 1] ?? null };
}
