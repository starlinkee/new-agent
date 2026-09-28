import { addCreature, addFood, resetWorld } from "/static/world-sim.js";

const BURST_SIZE = 8;
const BURST_SPREAD = 24;
const PICK_SLOP = 4;
const READOUT_INTERVAL_MS = 100;

function creatureAt(world, { x, y }) {
  let best = null;
  let bestDist = Infinity;
  for (const c of world.creatures) {
    const d = Math.hypot(c.x - x, c.y - y);
    if (d <= c.radius + PICK_SLOP && d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

function dropFoodBurst(world, point) {
  for (let i = 0; i < BURST_SIZE; i++) {
    const angle = world.random() * Math.PI * 2;
    const dist = Math.sqrt(world.random()) * BURST_SPREAD;
    const x = Math.min(world.width, Math.max(0, point.x + Math.cos(angle) * dist));
    const y = Math.min(world.height, Math.max(0, point.y + Math.sin(angle) * dist));
    if (!addFood(world, x, y)) return;
  }
}

// Wires the HUD, controls and inspector to a running world. `control` is the run state the frame loop
// reads ({ paused, speed }). Returns { draw(ctx, now) }, to be called once per animation frame after the
// world is drawn: it paints the selection highlight and refreshes the readouts a few times per second.
export function initHud({ world, control, canvas, root = document }) {
  const el = (id) => root.getElementById(id);
  const nodes = {
    pop: el("pop-count"),
    food: el("food-count"),
    gen: el("max-gen"),
    elapsed: el("elapsed"),
    empty: el("inspector-empty"),
    stats: el("inspector-stats"),
    status: el("insp-status"),
    energy: el("insp-energy"),
    age: el("insp-age"),
    creatureGen: el("insp-gen"),
    speed: el("insp-speed"),
    color: el("insp-color"),
    swatch: el("insp-swatch"),
  };
  const pauseButton = el("pause");
  const speedButtons = [...root.querySelectorAll("button.speed")];

  let selected = null;
  let lastReadout = -Infinity;

  const setText = (node, value) => {
    const text = String(value);
    if (node.textContent !== text) node.textContent = text;
  };

  canvas.addEventListener("click", (event) => {
    const rect = canvas.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (event.shiftKey) {
      addCreature(world, point);
      return;
    }
    const hit = creatureAt(world, point);
    selected = hit;
    if (!hit) dropFoodBurst(world, point);
  });

  pauseButton.addEventListener("click", () => {
    control.paused = !control.paused;
    pauseButton.textContent = control.paused ? "Resume" : "Pause";
    pauseButton.setAttribute("aria-pressed", String(control.paused));
  });

  for (const button of speedButtons) {
    button.addEventListener("click", () => {
      control.speed = Number(button.dataset.speed);
      for (const other of speedButtons) other.setAttribute("aria-pressed", String(other === button));
    });
  }

  el("reset").addEventListener("click", () => {
    resetWorld(world);
    selected = null;
    lastReadout = -Infinity;
  });

  function renderReadouts(alive) {
    let maxGen = 0;
    for (const c of world.creatures) if (c.generation > maxGen) maxGen = c.generation;
    setText(nodes.pop, world.creatures.length);
    setText(nodes.food, world.food.length);
    setText(nodes.gen, maxGen);
    setText(nodes.elapsed, world.time.toFixed(1));

    nodes.empty.hidden = selected !== null;
    nodes.stats.hidden = selected === null;
    if (!selected) return;
    setText(nodes.status, alive ? "alive" : "died");
    setText(nodes.energy, selected.energy.toFixed(1));
    setText(nodes.age, `${selected.age.toFixed(1)}s`);
    setText(nodes.creatureGen, selected.generation);
    setText(nodes.speed, selected.speed.toFixed(1));
    const color = `hsl(${Math.round(selected.hue)}, 80%, 60%)`;
    setText(nodes.color, color);
    nodes.swatch.style.background = color;
  }

  return {
    draw(ctx, now) {
      const alive = selected !== null && world.creatures.includes(selected);
      if (alive) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(selected.x, selected.y, selected.radius + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (now - lastReadout >= READOUT_INTERVAL_MS) {
        lastReadout = now;
        renderReadouts(alive);
      }
    },
  };
}
