import { initHud } from "/static/hud.js";
import { createWorld, resizeWorld, step } from "/static/world-sim.js";
import { createEvents } from "/static/events.js";
import { createTicker } from "/static/ticker.js";
import { createStats } from "/static/stats.js";

const canvas = document.getElementById("world");
const ctx = canvas.getContext("2d");
const world = createWorld({ width: canvas.clientWidth, height: canvas.clientHeight });
const events = createEvents();
const ticker = createTicker(document.getElementById("ticker"));
const stats = createStats();
const control = { paused: false, speed: 1 };
const hud = initHud({ world, control, canvas });
window.__events = events;
document.getElementById("trigger-event").addEventListener("click", () => events.trigger(world));

// Test hooks only; nothing in the app reads these.
window.__world = world;
window.__worldControl = control;
window.__stats = stats;

function resize() {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  resizeWorld(world, width, height);
}

function drawEffects() {
  for (const e of events.effects) {
    const t = Math.min(e.age / e.duration, 1);
    if (e.type === "meteor") {
      ctx.strokeStyle = `rgba(255, 140, 40, ${1 - t})`;
      ctx.fillStyle = `rgba(255, 80, 20, ${0.5 * (1 - t)})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.radius * Math.min(t * 3, 1), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (e.type === "bloom") {
      ctx.fillStyle = `rgba(61, 220, 106, ${0.25 * (1 - t)})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.radius, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.type === "plague") {
      ctx.strokeStyle = "rgba(160, 90, 220, 0.8)";
      ctx.lineWidth = 2;
      for (const c of e.victims) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, c.radius + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}

function draw() {
  ctx.clearRect(0, 0, world.width, world.height);
  ctx.fillStyle = "#3ddc6a";
  for (const f of world.food) {
    ctx.beginPath();
    ctx.arc(f.x, f.y, world.config.foodRadius, 0, Math.PI * 2);
    ctx.fill();
  }
  drawEffects();
  for (const c of world.creatures) {
    const fullness = Math.min(c.energy / world.config.maxEnergy, 1);
    ctx.fillStyle = `hsl(${c.hue} 80% ${30 + fullness * 35}%)`;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  events.update(world, dt);
  if (!control.paused) for (let i = 0; i < control.speed; i++) {
    step(world, dt);
    stats.maybeSample(world);
  }
  ticker.drain(world);
  draw();
  hud.draw(ctx, now);
  requestAnimationFrame(frame);
}

window.addEventListener("resize", resize);
resize();
requestAnimationFrame(frame);
