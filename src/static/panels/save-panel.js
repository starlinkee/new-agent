import { serializeWorld, restoreWorld } from "/static/world-serialize.js";
import { record } from "/static/world-sim.js";

const API = "/api/world/snapshots";

async function request(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      message = (await res.json()).error || message;
    } catch {}
    throw new Error(message);
  }
  return res.status === 204 ? undefined : res.json();
}

export const slot = "panel-save";

export function mount(el, { world }) {
  el.classList.add("world-panel");
  el.innerHTML = `<h2>Save &amp; load</h2>
<form id="save-form">
  <input id="save-name" type="text" maxlength="60" placeholder="Snapshot name" aria-label="Snapshot name" required>
  <button id="save-button" type="submit">Save</button>
</form>
<p id="save-status" role="status"></p>
<ul id="save-list"></ul>`;
  const form = el.querySelector("#save-form");
  const input = el.querySelector("#save-name");
  const status = el.querySelector("#save-status");
  const list = el.querySelector("#save-list");

  function setStatus(text, isError = false) {
    status.textContent = text;
    status.dataset.state = isError ? "error" : "ok";
  }

  function row(snapshot) {
    const li = document.createElement("li");
    li.dataset.id = snapshot.id;
    const label = document.createElement("span");
    label.className = "save-label";
    label.textContent = `${snapshot.name} - ${Math.floor(snapshot.time)}s, ${snapshot.creatureCount} creatures`;
    const load = document.createElement("button");
    load.type = "button";
    load.textContent = "Load";
    load.addEventListener("click", () => loadSnapshot(snapshot));
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.addEventListener("click", () => deleteSnapshot(snapshot));
    li.append(label, " ", load, " ", del);
    return li;
  }

  let refreshToken = 0;
  async function refresh() {
    const token = ++refreshToken;
    try {
      const snapshots = await request(API);
      if (token === refreshToken) list.replaceChildren(...snapshots.map(row));
    } catch (err) {
      if (token === refreshToken) setStatus(`Could not list snapshots: ${err.message}`, true);
    }
  }

  let loadToken = 0;
  async function loadSnapshot(snapshot) {
    const token = ++loadToken;
    try {
      const { data } = await request(`${API}/${encodeURIComponent(snapshot.id)}`);
      if (token !== loadToken) return;
      restoreWorld(world, data);
      record(world, { kind: "event", type: "load", text: `Loaded "${snapshot.name}"` });
      setStatus(`Loaded "${snapshot.name}"`);
    } catch (err) {
      if (token === loadToken) setStatus(`Could not load "${snapshot.name}": ${err.message}`, true);
    }
  }

  async function deleteSnapshot(snapshot) {
    try {
      await request(`${API}/${encodeURIComponent(snapshot.id)}`, { method: "DELETE" });
      setStatus(`Deleted "${snapshot.name}"`);
      await refresh();
    } catch (err) {
      setStatus(`Could not delete "${snapshot.name}": ${err.message}`, true);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return setStatus("Enter a name first", true);
    try {
      await request(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, data: serializeWorld(world) }),
      });
      input.value = "";
      setStatus(`Saved "${name}"`);
      await refresh();
    } catch (err) {
      setStatus(`Could not save: ${err.message}`, true);
    }
  });

  return refresh();
}
