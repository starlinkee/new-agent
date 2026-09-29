// Creature inspector: click a creature on the canvas to follow its stats; a ring marks the selection.
import { delta, onDeath } from "/static/world-sim.js";
import { speciesColor } from "/static/render-species.js";

export const slot = "panel-inspector";

const PICK_MARGIN = 6; // px beyond the creature's radius that still counts as a hit
const REFRESH_MS = 100; // text refresh period; the canvas ring is drawn every frame

const FIELDS = [
  ["id", "Id"],
  ["species", "Species"],
  ["generation", "Generation"],
  ["age", "Age"],
  ["energy", "Energy"],
  ["speed", "Speed"],
  ["hue", "Hue"],
];

// Nearest creature whose radius + margin covers the point, measured on the wrapping world.
export function pickCreature(world, point) {
  let best = null;
  let bestDist = Infinity;
  for (const c of world.creatures) {
    const dist = Math.hypot(delta(c.x, point.x, world.width), delta(c.y, point.y, world.height));
    if (dist <= c.radius + PICK_MARGIN && dist < bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best;
}

export function mount(el, ctx) {
  if (!ctx?.world || !ctx.canvas || !Array.isArray(ctx.overlays) || !ctx.selection) {
    throw new Error("inspector panel requires ctx.world, ctx.canvas, ctx.overlays and ctx.selection");
  }
  const { world, canvas, overlays, selection } = ctx;

  const content = document.createElement("div");
  content.id = "inspector-content";
  content.setAttribute("aria-live", "polite");
  const message = document.createElement("p");
  message.style.margin = "0";
  const list = document.createElement("dl");
  list.style.cssText = "margin:0;grid-template-columns:auto 1fr;gap:0.2rem 0.75rem";
  const values = {};
  for (const [key, label] of FIELDS) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.style.margin = "0";
    dd.dataset.field = key;
    values[key] = dd;
    list.append(dt, dd);
  }
  const bar = document.createElement("progress");
  bar.max = world.config.maxEnergy;
  bar.style.cssText = "width:6rem;vertical-align:middle;margin-right:0.5rem";
  const energyText = document.createElement("span");
  values.energy.append(bar, energyText);
  const swatch = document.createElement("span");
  swatch.style.cssText = "display:inline-block;width:1rem;height:1rem;vertical-align:middle;margin-right:0.5rem;border:1px solid #888";
  const hueText = document.createElement("span");
  values.hue.append(swatch, hueText);
  content.append(message, list);
  el.append(content);

  let selected = null;
  selection.id = null;

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function showEmpty() {
    list.style.display = "none";
    message.hidden = false;
    setText(message, "Click a creature to inspect it.");
  }

  function showDeath(text) {
    list.style.display = "none";
    message.hidden = false;
    setText(message, text);
  }

  function showCreature(c) {
    message.hidden = true;
    list.style.display = "grid";
    setText(values.id, `#${c.id}`);
    setText(values.species, c.species);
    setText(values.generation, String(c.generation));
    setText(values.age, `${c.age.toFixed(1)} s`);
    const energy = Math.max(0, c.energy);
    if (bar.value !== energy) bar.value = energy;
    setText(energyText, c.energy.toFixed(1));
    setText(values.speed, c.speed.toFixed(1));
    setText(hueText, String(Math.round(c.hue)));
    const color = `hsl(${c.hue} 80% 50%)`;
    if (swatch.dataset.color !== color) {
      swatch.dataset.color = color;
      swatch.style.background = color;
    }
  }

  function select(c) {
    selected = c;
    selection.id = c ? c.id : null;
  }

  function reportDeath(c, cause) {
    select(null);
    showDeath(`Creature #${c.id} died (${cause})`);
  }

  // Death notification from the sim; covers deaths inside step() and silent ones (meteor).
  const stopDeaths = onDeath(world, (c, cause) => {
    if (selected === c) reportDeath(c, cause);
  });

  function refresh() {
    if (!selected) return;
    if (selected.dead || !world.creatures.includes(selected)) {
      reportDeath(selected, "removed"); // dropped without dying, e.g. a world reset
      return;
    }
    showCreature(selected);
  }

  // Canvas only: ring at every wrapped copy of the selected creature that is visible.
  function overlay(g) {
    if (!selected) return;
    const r = selected.radius + 5;
    g.save();
    g.strokeStyle = speciesColor(selected.species);
    g.lineWidth = 2;
    for (const dx of [0, world.width, -world.width]) {
      for (const dy of [0, world.height, -world.height]) {
        const x = selected.x + dx;
        const y = selected.y + dy;
        if (x + r < 0 || y + r < 0 || x - r > world.width || y - r > world.height) continue;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.stroke();
      }
    }
    g.restore();
  }

  function onClick(event) {
    if (event.shiftKey) return; // shift-click adds a creature
    const rect = canvas.getBoundingClientRect();
    // World units are canvas layout pixels; scale in case CSS displays the canvas at another size.
    const point = {
      x: ((event.clientX - rect.left) * world.width) / rect.width,
      y: ((event.clientY - rect.top) * world.height) / rect.height,
    };
    select(pickCreature(world, point));
    if (selected) showCreature(selected);
    else showEmpty();
  }

  showEmpty();
  canvas.addEventListener("click", onClick);
  overlays.push(overlay);
  const timer = setInterval(refresh, REFRESH_MS);

  return () => {
    clearInterval(timer);
    stopDeaths();
    canvas.removeEventListener("click", onClick);
    const at = overlays.indexOf(overlay);
    if (at >= 0) overlays.splice(at, 1);
    select(null);
  };
}
