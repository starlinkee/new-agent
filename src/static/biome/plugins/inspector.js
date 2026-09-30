// Inspector plugin: click a creature to open a live card and optionally follow it with the camera.

import { heightAt } from "../terrain.js";

const NAME = "inspector";
const FOLLOW_EASE = 5;
const CLOSE_AFTER_DIED_MS = 3000;
const RING_INNER = 1;
const RING_OUTER = 1.25;

export function mount(ctx) {
  const { THREE, scene, camera, controls, hud } = ctx;

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./inspector.css", import.meta.url).href;
  document.head.appendChild(link);

  const tool = document.createElement("div");
  tool.className = "biome-tool";
  tool.dataset.plugin = NAME;
  hud.appendChild(tool);

  const group = new THREE.Group();
  group.name = `biome-plugin-${NAME}`;
  scene.add(group);

  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false });
  const ringGeometry = new THREE.RingGeometry(RING_INNER, RING_OUTER, 40);
  ringGeometry.rotateX(-Math.PI / 2);

  let selectedId = null;
  let lastGeneration = null;
  let following = false;
  let died = false;
  let closeTimer = null;
  let card = null;
  let ring = null;
  let fields = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildCard() {
    card = el("div");
    card.id = "biome-inspector";
    const head = el("div", "biome-inspector-head");
    const swatch = el("span", "biome-inspector-swatch");
    const title = el("span", "biome-inspector-title");
    const close = el("button", "", "×");
    close.id = "biome-inspector-close";
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", deselect);
    head.append(swatch, title, close);

    const list = el("dl");
    const row = (label) => {
      const dd = el("dd");
      list.append(el("dt", "", label), dd);
      return dd;
    };
    const id = row("Id");
    const generation = row("Generation");
    const energy = row("Energy");
    const bar = el("span", "biome-inspector-bar");
    const fill = el("span", "biome-inspector-fill");
    bar.append(fill);
    const energyText = el("span");
    energy.append(bar, energyText);
    const age = row("Age");

    const follow = el("button", "", "Follow");
    follow.id = "biome-follow";
    follow.type = "button";
    follow.addEventListener("click", () => setFollowing(!following));

    card.append(head, list, follow);
    tool.appendChild(card);
    fields = { swatch, title, id, generation, fill, energyText, age, follow };
  }

  function setFollowing(value) {
    following = value;
    if (fields) fields.follow.textContent = following ? "Stop following" : "Follow";
  }

  function removeRing() {
    if (!ring) return;
    group.remove(ring);
    ring = null;
  }

  function deselect() {
    clearTimeout(closeTimer);
    closeTimer = null;
    selectedId = null;
    lastGeneration = null;
    died = false;
    setFollowing(false);
    removeRing();
    if (card) card.remove();
    card = null;
    fields = null;
  }

  function render(creature) {
    const { swatch, title, id, generation, fill, energyText, age } = fields;
    if (creature) {
      lastGeneration = creature.generation;
      swatch.style.background = `hsl(${creature.hue}, 70%, 55%)`;
      title.textContent = creature.species;
      id.textContent = `#${creature.id}`;
      generation.textContent = String(creature.generation);
      const energy = Math.max(0, Math.min(100, creature.energy));
      fill.style.width = `${energy}%`;
      energyText.textContent = String(creature.energy);
      age.textContent = `${creature.age} s`;
    } else {
      title.textContent = "Died";
      generation.textContent = String(lastGeneration ?? "-");
    }
  }

  function select(id) {
    if (id === selectedId && card) return;
    deselect();
    const creature = ctx.getState()?.creatures.find((c) => c.id === id);
    if (!creature) return;
    selectedId = id;
    buildCard();
    render(creature);
  }

  function markDied() {
    died = true;
    setFollowing(false);
    removeRing();
    card.classList.add("is-dead");
    render(null);
    closeTimer = setTimeout(deselect, CLOSE_AFTER_DIED_MS);
  }

  const offPick = ctx.onPick(({ creatureId }) => {
    if (creatureId !== null && creatureId !== undefined) select(creatureId);
  });

  const offState = ctx.onState((state) => {
    if (selectedId === null || died) return;
    const creature = state.creatures.find((c) => c.id === selectedId);
    if (creature) render(creature);
    else markDied();
  });

  const offFrame = ctx.onFrame((dt, now) => {
    if (selectedId === null || died) return;
    const object = ctx.creatureObject(selectedId);
    if (!object) return;
    const { x, z } = object.position;
    if (!ring) {
      ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.renderOrder = 10;
      group.add(ring);
    }
    const radius = Math.max(object.scale.x, object.scale.z);
    const pulse = 1 + 0.15 * Math.sin(now * 0.006);
    ring.position.set(x, heightAt(x, z) + 0.5, z);
    ring.scale.setScalar(radius * pulse * 1.4);
    if (following) {
      const k = Math.min(1, FOLLOW_EASE * dt);
      const dx = (x - controls.target.x) * k;
      const dy = (object.position.y - controls.target.y) * k;
      const dz = (z - controls.target.z) * k;
      controls.target.x += dx;
      controls.target.y += dy;
      controls.target.z += dz;
      camera.position.x += dx;
      camera.position.y += dy;
      camera.position.z += dz;
    }
  });

  function onKeydown(event) {
    if (event.key === "Escape" && card) deselect();
  }
  document.addEventListener("keydown", onKeydown);

  return () => {
    offPick();
    offState();
    offFrame();
    document.removeEventListener("keydown", onKeydown);
    deselect();
    ringGeometry.dispose();
    ringMaterial.dispose();
    scene.remove(group);
    tool.remove();
    link.remove();
  };
}
