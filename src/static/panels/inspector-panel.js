// Creature inspector: click a creature on the canvas to follow its stats; a ring marks the selection.
import { delta } from "/static/world-sim.js";
import { speciesColor } from "/static/render-species.js";

export const slot = "panel-inspector";

const PICK_MARGIN = 6; // px beyond the creature's radius that still counts as a hit

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
  if (!ctx?.world || !ctx.canvas || !Array.isArray(ctx.overlays)) {
    throw new Error("inspector panel requires ctx.world, ctx.canvas and ctx.overlays");
  }
  const { world, canvas, overlays } = ctx;

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
  world.selectedId = null;

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
    setText(values.species, c.species ?? "herbivore");
    setText(values.generation, String(c.generation));
    setText(values.age, `${c.age.toFixed(1)} s`);
    bar.value = Math.max(0, c.energy);
    setText(energyText, c.energy.toFixed(1));
    setText(values.speed, c.speed.toFixed(1));
    setText(hueText, String(Math.round(c.hue)));
    swatch.style.background = `hsl(${c.hue} 80% 50%)`;
  }

  function deathCause(id) {
    for (let i = world.log.length - 1; i >= 0; i--) {
      const entry = world.log[i];
      if (entry.kind === "death" && entry.id === id) return entry.cause;
    }
    return null;
  }

  // Runs every frame: refreshes the panel, notices death, and draws the highlight ring.
  function overlay(g) {
    if (!selected) return;
    if (selected.dead || !world.creatures.includes(selected)) {
      const cause = deathCause(selected.id) ?? "removed";
      showDeath(`Creature #${selected.id} died (${cause})`);
      selected = null;
      world.selectedId = null;
      return;
    }
    showCreature(selected);
    g.save();
    g.strokeStyle = speciesColor(selected.species ?? "herbivore");
    g.lineWidth = 2;
    g.beginPath();
    g.arc(selected.x, selected.y, selected.radius + 5, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }

  function onClick(event) {
    if (event.shiftKey) return; // shift-click adds a creature
    const rect = canvas.getBoundingClientRect();
    const hit = pickCreature(world, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    selected = hit;
    world.selectedId = hit ? hit.id : null;
    if (hit) showCreature(hit);
    else showEmpty();
  }

  showEmpty();
  canvas.addEventListener("click", onClick);
  overlays.push(overlay);

  return () => {
    canvas.removeEventListener("click", onClick);
    const at = overlays.indexOf(overlay);
    if (at >= 0) overlays.splice(at, 1);
  };
}
