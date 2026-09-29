export const SPECIES = ["herbivore", "predator"];

const PREDATOR_HUE_MIN = 345;
const PREDATOR_HUE_MAX = 375; // wraps past 360 into 0-15

export function speciesOf(c) {
  return c.species ?? "herbivore";
}

export function predatorHue(hue) {
  const t = ((hue % 360) + 360) % 360 / 360;
  return (PREDATOR_HUE_MIN + t * (PREDATOR_HUE_MAX - PREDATOR_HUE_MIN)) % 360;
}

// One color per species, shared by the legend and the population chart.
const SPECIES_COLORS = { herbivore: "hsl(140 80% 50%)", predator: "hsl(0 80% 50%)" };

export function speciesColor(name) {
  if (SPECIES_COLORS[name]) return SPECIES_COLORS[name];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 60%)`;
}

function shapePath(ctx, shape, x, y, r, heading) {
  ctx.beginPath();
  if (shape === "circle") {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  } else if (shape === "triangle") {
    const tip = r * 1.5;
    const back = r * 1.1;
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    ctx.moveTo(x + cos * tip, y + sin * tip);
    ctx.lineTo(x - cos * back - sin * back, y - sin * back + cos * back);
    ctx.lineTo(x - cos * back + sin * back, y - sin * back - cos * back);
    ctx.closePath();
  } else {
    const d = r * 1.3;
    ctx.moveTo(x, y - d);
    ctx.lineTo(x + d, y);
    ctx.lineTo(x, y + d);
    ctx.lineTo(x - d, y);
    ctx.closePath();
  }
}

function shapeOf(species) {
  if (species === "herbivore") return "circle";
  if (species === "predator") return "triangle";
  return "diamond";
}

export function drawCreature(ctx, world, c) {
  const species = speciesOf(c);
  const fullness = Math.min(c.energy / world.config.maxEnergy, 1);
  const hue = species === "predator" ? predatorHue(c.hue) : c.hue;
  ctx.fillStyle = `hsl(${hue} 80% ${30 + fullness * 35}%)`;
  shapePath(ctx, shapeOf(species), c.x, c.y, c.radius, c.heading);
  ctx.fill();
  return species;
}

export function renderLegend(el) {
  el.replaceChildren();
  for (const species of SPECIES) {
    const item = document.createElement("span");
    item.className = "legend-entry";
    item.dataset.species = species;
    item.style.cssText = "display:inline-flex;align-items:center;gap:0.35rem;margin-right:1rem";
    const swatch = document.createElement("canvas");
    swatch.width = 24;
    swatch.height = 24;
    const sctx = swatch.getContext("2d");
    sctx.fillStyle = speciesColor(species);
    shapePath(sctx, shapeOf(species), 12, 12, 7, -Math.PI / 2);
    sctx.fill();
    item.append(swatch, document.createTextNode(species));
    el.append(item);
  }
}
