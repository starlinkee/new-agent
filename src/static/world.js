import { initHud } from "/static/hud.js";
import { createAtmosphere } from "/static/atmosphere.js";
import { createWorld, resizeWorld, step } from "/static/world-sim.js";
import { createEvents } from "/static/events.js";
import { ECOSYSTEM_EVENTS } from "/static/events-ecosystem.js";
import { ECOSYSTEM_RENDERERS } from "/static/render-ecosystem.js";
import { createTicker } from "/static/ticker.js";
import { createStats } from "/static/stats.js";
import { drawCreature, renderLegend } from "/static/render-species.js";
import { mountPanels } from "/static/panels/index.js";
import { enablePredators } from "/static/predators.js";

const canvas = document.getElementById("world");
const ctx = canvas.getContext("2d");
const world = createWorld({ width: canvas.clientWidth, height: canvas.clientHeight });
enablePredators(world);
const events = createEvents({ extensions: ECOSYSTEM_EVENTS });
const ticker = createTicker(document.getElementById("ticker"));
const stats = createStats();
const control = { paused: false, speed: 1 };
// Panels push fn(ctx2d) here to draw on top of the world each frame.
const overlays = [];
// Which creature the inspector follows; view state, kept out of the sim world.
const selection = { id: null };
window.__selection = selection;
window.__overlays = overlays;
const hud = initHud({ world, control, canvas });
const atmosphere = createAtmosphere();
window.__atmosphere = atmosphere;
window.__events = events;
document.getElementById("trigger-event").addEventListener("click", () => events.trigger(world));

// Test hooks only; nothing in the app reads these.
window.__world = world;
window.__worldControl = control;
window.__stats = stats;
window.__renderStats = { drawn: { herbivore: 0, predator: 0 } };

const legend = document.createElement("div");
legend.id = "legend";
document.querySelector(".world-layout").after(legend);
renderLegend(legend);

function resize() {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  resizeWorld(world, width, height);
}

// Draw code per effect type, fn(ctx2d, effect, world). Unknown types are reported once rather than vanishing silently.
const EFFECT_RENDERERS = {
  meteor(ctx, e) {
    const t = Math.min(e.age / e.duration, 1);
    ctx.strokeStyle = `rgba(255, 140, 40, ${1 - t})`;
    ctx.fillStyle = `rgba(255, 80, 20, ${0.5 * (1 - t)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.radius * Math.min(t * 3, 1), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  },
  bloom(ctx, e) {
    const t = Math.min(e.age / e.duration, 1);
    ctx.fillStyle = `rgba(61, 220, 106, ${0.25 * (1 - t)})`;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.radius, 0, Math.PI * 2);
    ctx.fill();
  },
  plague(ctx, e) {
    ctx.strokeStyle = "rgba(160, 90, 220, 0.8)";
    ctx.lineWidth = 2;
    for (const c of e.victims) {
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.radius + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  },
  ...ECOSYSTEM_RENDERERS,
};
const unrenderable = new Set();

function drawEffects() {
  for (const e of events.effects) {
    const render = EFFECT_RENDERERS[e.type];
    if (render) {
      render(ctx, e, world);
    } else if (!unrenderable.has(e.type)) {
      unrenderable.add(e.type);
      console.warn(`No renderer for event effect "${e.type}"`);
    }
  }
}

function draw() {
  atmosphere.draw(ctx, world.width, world.height);
  for (const f of world.food) atmosphere.drawGlow(ctx, f.x, f.y, world.config.foodRadius);
  for (const c of world.creatures) atmosphere.drawGlow(ctx, c.x, c.y, c.radius);
  ctx.fillStyle = "#3ddc6a";
  for (const f of world.food) {
    ctx.beginPath();
    ctx.arc(f.x, f.y, world.config.foodRadius, 0, Math.PI * 2);
    ctx.fill();
  }
  drawEffects();
  const drawn = { herbivore: 0, predator: 0 };
  for (const c of world.creatures) {
    const species = drawCreature(ctx, world, c);
    drawn[species] = (drawn[species] ?? 0) + 1;
  }
  atmosphere.drawWeather(ctx);
  for (const overlay of [...overlays]) {
    try {
      overlay(ctx);
    } catch (err) {
      console.error("overlay failed and was removed", err);
      overlays.splice(overlays.indexOf(overlay), 1);
    }
  }
  window.__renderStats = { drawn };
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  events.update(world, dt);
  if (!control.paused) for (let i = 0; i < control.speed; i++) {
    step(world, dt);
    stats.maybeSample(world);
  }
  atmosphere.update(dt, world.width, world.height);
  draw();
  ticker.drain(world);
  hud.draw(ctx, now);
}

window.addEventListener("resize", resize);
resize();
const unmountPanels = mountPanels({ world, events, canvas, stats, control, overlays, selection });
window.addEventListener("pagehide", unmountPanels);
requestAnimationFrame(frame);
