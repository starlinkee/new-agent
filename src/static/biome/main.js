import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mountPlugins } from "./plugins/index.js";
import { createScene } from "./scene.js";
import { heightAt } from "./terrain.js";

const root = document.getElementById("biome-root");
const hud = document.getElementById("biome-hud");
const canvas = document.getElementById("biome-canvas");
const nameForm = document.getElementById("biome-name-form");
const nameInput = document.getElementById("biome-name");
const status = document.getElementById("biome-status");

const NAME_KEY = "biome-name";
const POSE_INTERVAL_MS = 200;
const POSE_HEARTBEAT_MS = 5000;
const POSE_MIN_MOVE = 1;
const POSE_MIN_TURN = 0.01;
const PICK_MAX_DRAG = 5;
const STREAM_EVENTS = ["joined", "left", "happening", "emote", "food"];

let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
} catch {
  renderer = null;
  status.textContent = "3D view unavailable: WebGL is disabled in this browser.";
}

const world = createScene();
const { scene } = world;

const camera = new THREE.PerspectiveCamera(55, 1, 1, 6000);
camera.position.set(0, 420, 520);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = 1.45;
controls.minDistance = 60;
controls.maxDistance = 1100;
controls.target.set(0, 0, 0);
controls.update();

let state = null;
let myId = null;
const listeners = { state: new Set(), event: new Set(), frame: new Set(), pick: new Set() };

function on(set) {
  return (listener) => {
    set.add(listener);
    return () => set.delete(listener);
  };
}

function notify(set, ...args) {
  for (const listener of [...set]) {
    try {
      listener(...args);
    } catch (err) {
      console.error("biome listener failed", err);
    }
  }
}

async function api(path, body) {
  const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    // 204 and other empty bodies
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

const getMe = () => (state && myId ? (state.observers.find((o) => o.id === myId) ?? null) : null);

// ---- observing ----

function storedName() {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
}

function storeName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // storage unavailable: the name only lasts for this page view
  }
}

let currentName = storedName() || `Guest-${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
let lastSent = { x: NaN, y: NaN, z: NaN, yaw: NaN, pitch: NaN, at: 0 };

async function observe(name = currentName) {
  const res = await api("/api/biome/observe", { name });
  if (!res.ok) return null;
  currentName = name;
  myId = res.body.id;
  lastSent.at = 0;
  return res.body;
}

async function leave() {
  myId = null;
  await api("/api/biome/leave");
}

nameInput.value = currentName;
nameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  if (await observe(name)) storeName(name);
});

// ---- camera pose ----

// yaw is the camera's rotation about the y axis (0 looks along -z), pitch its elevation.
function cameraPose() {
  const dir = camera.getWorldDirection(new THREE.Vector3());
  return { x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw: Math.atan2(-dir.x, -dir.z), pitch: Math.asin(Math.max(-1, Math.min(1, dir.y))) };
}

let posting = false;
async function sendPose() {
  if (!myId || posting) return;
  const pose = cameraPose();
  const moved = Math.hypot(pose.x - lastSent.x, pose.y - lastSent.y, pose.z - lastSent.z) >= POSE_MIN_MOVE;
  const turned = Math.abs(pose.pitch - lastSent.pitch) >= POSE_MIN_TURN || Math.abs(Math.atan2(Math.sin(pose.yaw - lastSent.yaw), Math.cos(pose.yaw - lastSent.yaw))) >= POSE_MIN_TURN;
  const now = performance.now();
  if (!(moved || turned || Number.isNaN(lastSent.x) || now - lastSent.at >= POSE_HEARTBEAT_MS)) return;
  posting = true;
  lastSent = { ...pose, at: now };
  try {
    const res = await api("/api/biome/pose", pose);
    if (res.status === 404) await observe();
  } catch {
    // network hiccup: the next interval retries
  } finally {
    posting = false;
  }
}
setInterval(sendPose, POSE_INTERVAL_MS);

window.addEventListener("pagehide", () => navigator.sendBeacon("/api/biome/leave"));

// ---- stream ----

const stream = new EventSource("/api/biome/stream");
stream.addEventListener("state", (event) => {
  state = JSON.parse(event.data);
  world.sync(state);
  notify(listeners.state, state);
});
for (const type of STREAM_EVENTS) {
  stream.addEventListener(type, (event) => notify(listeners.event, { type, ...JSON.parse(event.data) }));
}

// ---- picking ----

const raycaster = new THREE.Raycaster();
let down = null;

function pick(event) {
  scene.updateMatrixWorld();
  camera.updateMatrixWorld();
  const rect = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), camera);
  const creature = raycaster.intersectObject(world.creatures, true)[0];
  const ground = raycaster.intersectObject(world.terrain, false)[0];
  return {
    creatureId: creature ? creature.object.userData.id : null,
    point: ground ? world.toSim(ground.point.x, ground.point.z) : null,
    shiftKey: event.shiftKey,
  };
}

canvas.addEventListener("pointerdown", (event) => {
  down = { x: event.clientX, y: event.clientY };
});
canvas.addEventListener("pointerup", (event) => {
  const start = down;
  down = null;
  if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) >= PICK_MAX_DRAG) return;
  notify(listeners.pick, pick(event));
});

// ---- frame loop ----

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (renderer) renderer.setSize(width, height, false);
}
new ResizeObserver(resize).observe(canvas);
resize();

function keepTargetInWorld() {
  const { width, height } = world.size();
  const { target } = controls;
  const x = Math.max(-width / 2, Math.min(width / 2, target.x));
  const z = Math.max(-height / 2, Math.min(height / 2, target.z));
  camera.position.x += x - target.x;
  camera.position.z += z - target.z;
  target.x = x;
  target.z = z;
}

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  world.animate(now);
  notify(listeners.frame, dt, now);
  controls.update();
  keepTargetInWorld();
  scene.updateMatrixWorld();
  camera.updateMatrixWorld();
  if (renderer) renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

const ctx = {
  root,
  hud,
  THREE,
  scene,
  camera,
  controls,
  renderer,
  getState: () => state,
  getMe,
  onState: on(listeners.state),
  onEvent: on(listeners.event),
  onFrame: on(listeners.frame),
  onPick: on(listeners.pick),
  creatureObject: world.creatureObject,
  api,
};

function toScreen(simX, simY) {
  const { width, height } = world.size();
  const p = new THREE.Vector3(simX - width / 2, 0, simY - height / 2);
  p.y = heightAt(p.x, p.z);
  camera.updateMatrixWorld();
  p.project(camera);
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
}

window.__biome = {
  get state() {
    return state;
  },
  get me() {
    return getMe();
  },
  scene,
  camera,
  controls,
  webgl: renderer !== null,
  ctx,
  observe,
  leave,
  toScreen,
};

mountPlugins(ctx);
requestAnimationFrame(frame);
observe();
