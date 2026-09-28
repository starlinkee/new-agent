import { addCreature, addFood, createWorld } from "/static/world-sim.js";

const BURST_SIZE = 8;
const BURST_SPREAD = 24;
const PICK_SLOP = 4;

const world = window.__world;
const control = window.__worldControl;
const canvas = document.getElementById("world");
const $ = (id) => document.getElementById(id);

let selected = null;

function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function creatureAt({ x, y }) {
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

canvas.addEventListener("click", (event) => {
  const point = pointerPosition(event);
  if (event.shiftKey) {
    addCreature(world, point);
    return;
  }
  const hit = creatureAt(point);
  if (hit) {
    selected = hit;
    return;
  }
  selected = null;
  for (let i = 0; i < BURST_SIZE; i++) {
    const angle = world.random() * Math.PI * 2;
    const dist = Math.sqrt(world.random()) * BURST_SPREAD;
    addFood(
      world,
      Math.min(world.width, Math.max(0, point.x + Math.cos(angle) * dist)),
      Math.min(world.height, Math.max(0, point.y + Math.sin(angle) * dist)),
    );
  }
});

const pauseButton = $("pause");
pauseButton.addEventListener("click", () => {
  control.paused = !control.paused;
  pauseButton.textContent = control.paused ? "Resume" : "Pause";
  pauseButton.setAttribute("aria-pressed", String(control.paused));
});

const speedButtons = [...document.querySelectorAll("button.speed")];
for (const button of speedButtons) {
  button.addEventListener("click", () => {
    control.speed = Number(button.dataset.speed);
    for (const other of speedButtons) other.setAttribute("aria-pressed", String(other === button));
  });
}

$("reset").addEventListener("click", () => {
  const fresh = createWorld({ width: world.width, height: world.height, config: world.config });
  Object.assign(world, fresh);
  selected = null;
});

function renderHud() {
  $("pop-count").textContent = world.creatures.length;
  $("food-count").textContent = world.food.length;
  $("max-gen").textContent = world.creatures.reduce((max, c) => Math.max(max, c.generation), 0);
  $("elapsed").textContent = world.time.toFixed(1);
}

function renderInspector() {
  $("inspector-empty").hidden = selected !== null;
  $("inspector-stats").hidden = selected === null;
  if (!selected) return;
  const alive = world.creatures.includes(selected);
  $("insp-status").textContent = alive ? "alive" : "died";
  const c = selected;
  $("insp-energy").textContent = c.energy.toFixed(1);
  $("insp-age").textContent = `${c.age.toFixed(1)}s`;
  $("insp-gen").textContent = c.generation;
  $("insp-speed").textContent = c.speed.toFixed(1);
  const color = `hsl(${Math.round(c.hue)}, 80%, 60%)`;
  $("insp-color").textContent = color;
  $("insp-swatch").style.background = color;
}

function highlight(ctx) {
  if (!selected || !world.creatures.includes(selected)) return;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(selected.x, selected.y, selected.radius + 4, 0, Math.PI * 2);
  ctx.stroke();
}

control.afterDraw = (ctx) => {
  highlight(ctx);
  renderHud();
  renderInspector();
};
