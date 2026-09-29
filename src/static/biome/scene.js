import * as THREE from "three";
import { heightAt, toScene, toSim } from "./terrain.js";

export const TICK_MS = 100;
const DEFAULT_SIZE = 900;
const SEGMENTS = 128;

const SAND = new THREE.Color(0xd9c98f);
const GRASS = new THREE.Color(0x5fa14e);
const ROCK = new THREE.Color(0x8c8a80);

const HERBIVORE_GEOMETRY = new THREE.SphereGeometry(1, 20, 14);
// Points along +x, like the herbivore's long axis, so both species share the heading rotation.
const PREDATOR_GEOMETRY = new THREE.ConeGeometry(0.8, 2.6, 16).rotateZ(-Math.PI / 2);
const FOOD_GEOMETRY = new THREE.IcosahedronGeometry(1.4, 0);
const FOOD_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x33cc55, emissive: 0x22aa44, emissiveIntensity: 0.8 });
const PREDATOR_MATERIAL = new THREE.MeshStandardMaterial({ color: 0xd62828, roughness: 0.6 });

function terrainColor(h, out) {
  if (h < 8) return out.copy(SAND).lerp(GRASS, h / 8);
  if (h < 20) return out.copy(GRASS);
  return out.copy(GRASS).lerp(ROCK, Math.min(1, (h - 20) / 6));
}

function buildTerrainGeometry(width, height) {
  const geometry = new THREE.PlaneGeometry(width, height, SEGMENTS, SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const color = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const h = heightAt(position.getX(i), position.getZ(i));
    position.setY(i, h);
    terrainColor(h, color).toArray(colors, i * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

const shortestAngle = (from, to) => from + ((((to - from + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;

// Builds the page-owned scene objects and keeps them in sync with server snapshots.
export function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.fog = new THREE.Fog(0xcfe8f5, 700, 2400);

  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.name = "biome-sun";
  sun.position.set(300, 500, 200);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -650, right: 650, top: 650, bottom: -650, near: 10, far: 1600 });
  scene.add(sun, sun.target);
  const ambient = new THREE.HemisphereLight(0xbfe3ff, 0x6b7a4a, 1.1);
  ambient.name = "biome-ambient";
  scene.add(ambient);

  const terrain = new THREE.Mesh(
    buildTerrainGeometry(DEFAULT_SIZE, DEFAULT_SIZE),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
  );
  terrain.name = "biome-terrain";
  terrain.receiveShadow = true;
  scene.add(terrain);

  const creatures = new THREE.Group();
  creatures.name = "biome-creatures";
  const food = new THREE.Group();
  food.name = "biome-food";
  scene.add(creatures, food);

  let size = { width: DEFAULT_SIZE, height: DEFAULT_SIZE };
  const tracks = new Map(); // creature id -> { object, from, to }
  let syncedAt = 0;

  function place(track, x, y, heading) {
    const { object, radius } = track;
    const p = toScene(x, y, size.width, size.height);
    object.position.set(p.x, p.y + radius, p.z);
    object.rotation.y = -heading;
  }

  function scaleCreature(track, radius) {
    const { object } = track;
    track.radius = radius;
    if (object.userData.species === "predator") object.scale.setScalar(radius);
    else object.scale.set(radius * 1.3, radius, radius);
  }

  function createCreature(c) {
    const predator = c.species === "predator";
    const object = predator
      ? new THREE.Mesh(PREDATOR_GEOMETRY, PREDATOR_MATERIAL)
      : new THREE.Mesh(HERBIVORE_GEOMETRY, new THREE.MeshStandardMaterial({ color: new THREE.Color(`hsl(${c.hue}, 70%, 55%)`), roughness: 0.55 }));
    object.castShadow = true;
    object.userData = { id: c.id, species: c.species };
    creatures.add(object);
    return object;
  }

  function syncCreatures(list) {
    const seen = new Set();
    for (const c of list) {
      seen.add(c.id);
      const next = { x: c.x, y: c.y, heading: c.heading };
      let track = tracks.get(c.id);
      if (!track) {
        track = { object: createCreature(c), from: next, to: next };
        scaleCreature(track, c.radius);
        tracks.set(c.id, track);
        place(track, c.x, c.y, c.heading);
        continue;
      }
      scaleCreature(track, c.radius);
      const wrapped = Math.abs(next.x - track.to.x) > size.width / 2 || Math.abs(next.y - track.to.y) > size.height / 2;
      track.from = wrapped ? next : track.to;
      track.to = next;
      if (track.from !== next) next.heading = shortestAngle(track.from.heading, c.heading);
    }
    for (const [id, track] of tracks) {
      if (seen.has(id)) continue;
      creatures.remove(track.object);
      if (track.object.material !== PREDATOR_MATERIAL) track.object.material.dispose();
      tracks.delete(id);
    }
  }

  function syncFood(list) {
    while (food.children.length > list.length) food.remove(food.children[food.children.length - 1]);
    while (food.children.length < list.length) {
      const item = new THREE.Mesh(FOOD_GEOMETRY, FOOD_MATERIAL);
      item.castShadow = true;
      food.add(item);
    }
    list.forEach(([x, y], i) => {
      const p = toScene(x, y, size.width, size.height);
      const item = food.children[i];
      item.userData.base = p.y + 3;
      item.position.set(p.x, item.userData.base, p.z);
    });
  }

  function sync(snapshot) {
    if (snapshot.width !== size.width || snapshot.height !== size.height) {
      size = { width: snapshot.width, height: snapshot.height };
      terrain.geometry.dispose();
      terrain.geometry = buildTerrainGeometry(size.width, size.height);
    }
    syncCreatures(snapshot.creatures);
    syncFood(snapshot.food);
    syncedAt = performance.now();
  }

  // Positions creatures between the last two snapshots and bobs the food.
  function animate(now) {
    const alpha = Math.min(1, Math.max(0, (now - syncedAt) / TICK_MS));
    for (const track of tracks.values()) {
      const { from, to } = track;
      place(track, from.x + (to.x - from.x) * alpha, from.y + (to.y - from.y) * alpha, from.heading + (to.heading - from.heading) * alpha);
    }
    food.children.forEach((item, i) => {
      item.position.y = item.userData.base + Math.sin(now * 0.003 + i) * 0.8;
      item.rotation.y = now * 0.001 + i;
    });
  }

  return {
    scene,
    terrain,
    creatures,
    sync,
    animate,
    size: () => size,
    creatureObject: (id) => tracks.get(id)?.object,
    toSim: (sx, sz) => toSim(sx, sz, size.width, size.height),
  };
}
