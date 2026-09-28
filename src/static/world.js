import { createWorld, resizeWorld, step } from "/static/world-sim.js";

const canvas = document.getElementById("world");
const ctx = canvas.getContext("2d");
const world = createWorld({ width: canvas.clientWidth, height: canvas.clientHeight });
window.__world = world;

function resize() {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  resizeWorld(world, width, height);
}

function draw() {
  ctx.clearRect(0, 0, world.width, world.height);
  ctx.fillStyle = "#3ddc6a";
  for (const f of world.food) {
    ctx.beginPath();
    ctx.arc(f.x, f.y, world.config.foodRadius, 0, Math.PI * 2);
    ctx.fill();
  }
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
  step(world, dt);
  draw();
  requestAnimationFrame(frame);
}

window.addEventListener("resize", resize);
resize();
requestAnimationFrame(frame);
