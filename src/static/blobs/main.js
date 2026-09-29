import { mountPlugins } from "./plugins/index.js";
import { computeCamera, draw } from "./render.js";

const root = document.getElementById("blobs-root");
const canvas = document.getElementById("blobs-canvas");
const hud = document.getElementById("blobs-hud");
const form = document.getElementById("blobs-join");
const nameInput = document.getElementById("blobs-name");
const playButton = document.getElementById("blobs-play");
const dead = document.getElementById("blobs-dead");
const status = document.getElementById("blobs-status");

let state = null;
let myId = null;
let playing = false;
let camera = computeCamera(null, null, 0, 0);
let pointer = null;
let lastSent = { x: NaN, y: NaN, at: 0 };
let frame = 0;
const stateListeners = new Set();
const eventListeners = new Set();

const getMe = () => (playing && state ? (state.players.find((p) => p.id === myId) ?? null) : null);

function subscribe(set) {
  return (listener) => {
    set.add(listener);
    return () => set.delete(listener);
  };
}

function notify(set, arg) {
  for (const listener of set) {
    try {
      listener(arg);
    } catch (err) {
      console.error("blobs listener failed", err);
    }
  }
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
}

function render() {
  frame = 0;
  const dpr = window.devicePixelRatio || 1;
  camera = computeCamera(state, getMe(), canvas.clientWidth, canvas.clientHeight);
  draw(canvas, dpr, state, camera);
  notify(stateListeners, state);
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

function showForm(playAgain) {
  form.hidden = false;
  playButton.textContent = playAgain ? "Play again" : "Play";
}

async function join(name) {
  status.textContent = "";
  const res = await fetch("/api/blobs/join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = body.error || `join failed (${res.status})`;
    status.textContent = message;
    throw new Error(message);
  }
  myId = body.id;
  playing = true;
  lastSent = { x: NaN, y: NaN, at: 0 };
  dead.hidden = true;
  form.hidden = true;
  schedule();
  return body;
}

function leave() {
  playing = false;
  navigator.sendBeacon("/api/blobs/leave");
  schedule();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  playButton.disabled = true;
  try {
    await join(nameInput.value);
  } catch {
    // the message is already in #blobs-status
  } finally {
    playButton.disabled = false;
  }
});

root.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
});

setInterval(() => {
  if (!playing || !pointer) return;
  const x = camera.x + (pointer.x - camera.width / 2) / camera.scale;
  const y = camera.y + (pointer.y - camera.height / 2) / camera.scale;
  const now = Date.now();
  const moved = !(Math.hypot(x - lastSent.x, y - lastSent.y) < 1);
  if (!moved && now - lastSent.at < 1000) return;
  lastSent = { x, y, at: now };
  fetch("/api/blobs/target", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x, y }),
  }).catch(() => {});
}, 50);

const source = new EventSource("/api/blobs/stream");
source.addEventListener("state", (e) => {
  state = JSON.parse(e.data);
  schedule();
});
for (const type of ["joined", "eaten", "left"]) {
  source.addEventListener(type, (e) => {
    const data = JSON.parse(e.data);
    if (type === "eaten" && playing && data.victim.id === myId) {
      playing = false;
      dead.textContent = `Eaten by ${data.eater.name} (peak mass ${Math.round(data.victim.peakMass)})`;
      dead.hidden = false;
      showForm(true);
    } else if (type === "left" && playing && data.player.id === myId) {
      playing = false;
      status.textContent = data.reason === "idle" ? "You were removed for being idle" : "";
      showForm(true);
    }
    notify(eventListeners, { type, ...data });
  });
}

window.addEventListener("resize", () => {
  resize();
  schedule();
});
window.addEventListener("pagehide", () => navigator.sendBeacon("/api/blobs/leave"));

resize();

const ctx = {
  root,
  hud,
  getState: () => state,
  getMe,
  getCamera: () => camera,
  onState: subscribe(stateListeners),
  onEvent: subscribe(eventListeners),
};

window.__blobs = {
  get state() {
    return state;
  },
  get me() {
    return getMe();
  },
  get camera() {
    return camera;
  },
  join,
  leave,
};

mountPlugins(ctx);
