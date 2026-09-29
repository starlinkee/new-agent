import { toScene } from "../terrain.js";

const FALL_HEIGHT = 300;
const FALL_MS = 800;
const SPLASH_MS = 500;
const SPLASH_RADIUS = 18;
const MESSAGE_MS = 2000;
// Mirrors the server's default token bucket (src/biome-food.js) to draw the cooldown bar.
const BURST = 5;
const REFILL_MS = 1000;
const DEFAULT_SIZE = 900;

export function mount(ctx) {
  const { THREE, scene, hud } = ctx;

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/static/biome/plugins/feeding.css";
  document.head.append(link);

  const tool = document.createElement("div");
  tool.className = "biome-tool";
  tool.dataset.plugin = "feeding";
  tool.innerHTML = `<div id="biome-feed"><span class="biome-feed-text">Click the ground to drop food</span><div class="biome-feed-bar" role="progressbar" aria-label="Food drops left" aria-valuemin="0" aria-valuemax="${BURST}"><div class="biome-feed-fill"></div></div></div>`;
  hud.append(tool);
  const text = tool.querySelector(".biome-feed-text");
  const bar = tool.querySelector(".biome-feed-bar");
  const fill = tool.querySelector(".biome-feed-fill");
  const hint = text.textContent;

  const group = new THREE.Group();
  group.name = "biome-plugin-feeding";
  scene.add(group);

  const seedGeometry = new THREE.SphereGeometry(3, 16, 12);
  const ringGeometry = new THREE.RingGeometry(0.85, 1, 32).rotateX(-Math.PI / 2);
  const drops = [];

  let tokens = BURST;
  let tokensAt = performance.now();
  let messageTimer = null;

  const currentTokens = (now) => Math.min(BURST, tokens + (now - tokensAt) / REFILL_MS);
  function spend(count, now) {
    tokens = Math.max(0, currentTokens(now) - count);
    tokensAt = now;
  }

  function showMessage(message) {
    text.textContent = message;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => {
      text.textContent = hint;
    }, MESSAGE_MS);
  }

  function drawBar(now) {
    const left = currentTokens(now);
    fill.style.width = `${(left / BURST) * 100}%`;
    bar.setAttribute("aria-valuenow", String(Math.floor(left)));
  }

  function spawn(event, now) {
    const state = ctx.getState();
    const point = toScene(event.x, event.y, state?.width ?? DEFAULT_SIZE, state?.height ?? DEFAULT_SIZE);
    const color = new THREE.Color(event.color);
    const seed = new THREE.Mesh(seedGeometry, new THREE.MeshBasicMaterial({ color }));
    seed.name = "biome-feeding-seed";
    const glow = new THREE.Mesh(seedGeometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false }));
    glow.scale.setScalar(2);
    seed.add(glow);
    seed.position.set(point.x, point.y + FALL_HEIGHT, point.z);
    group.add(seed);
    drops.push({ seed, point, color, born: now, ring: null });
  }

  function landed(drop, now) {
    drop.seed.removeFromParent();
    for (const mesh of [drop.seed, ...drop.seed.children]) mesh.material.dispose();
    const ring = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ color: drop.color, transparent: true, opacity: 0.9, depthWrite: false }));
    ring.name = "biome-feeding-splash";
    ring.position.set(drop.point.x, drop.point.y + 0.5, drop.point.z);
    group.add(ring);
    drop.seed = null;
    drop.ring = ring;
    drop.landedAt = now;
  }

  function animate(now) {
    for (let i = drops.length - 1; i >= 0; i--) {
      const drop = drops[i];
      if (drop.seed) {
        const t = Math.min(1, (now - drop.born) / FALL_MS);
        if (t < 1) {
          drop.seed.position.y = drop.point.y + FALL_HEIGHT * (1 - t * t);
          continue;
        }
        landed(drop, now);
      }
      const t = Math.min(1, (now - drop.landedAt) / SPLASH_MS);
      drop.ring.scale.setScalar(1 + SPLASH_RADIUS * t);
      drop.ring.material.opacity = 0.9 * (1 - t);
      if (t >= 1) {
        drop.ring.removeFromParent();
        drop.ring.material.dispose();
        drops.splice(i, 1);
      }
    }
  }

  const offPick = ctx.onPick(async ({ creatureId, point }) => {
    if (creatureId !== null || !point) return;
    const res = await ctx.api("/api/biome/food", { x: point.x, y: point.y });
    const now = performance.now();
    if (res.status === 201) {
      spend(1, now);
    } else if (res.status === 429) {
      spend(BURST, now);
      showMessage(res.body?.error ?? "slow down");
    } else if (res.status === 409) {
      showMessage(res.body?.error ?? "food is full");
    }
  });
  const offEvent = ctx.onEvent((event) => {
    if (event.type === "food") spawn(event, performance.now());
  });
  const offFrame = ctx.onFrame((dt, now) => {
    animate(now);
    drawBar(now);
  });
  drawBar(performance.now());

  return () => {
    offPick();
    offEvent();
    offFrame();
    clearTimeout(messageTimer);
    for (const drop of drops) {
      for (const mesh of [drop.seed, ...(drop.seed?.children ?? []), drop.ring]) mesh?.material.dispose();
    }
    seedGeometry.dispose();
    ringGeometry.dispose();
    group.removeFromParent();
    tool.remove();
    link.remove();
  };
}
