import { getEvent, saveAvailability, withdrawAvailability } from "./api.js";
import { el, mountHeatmap, mountSelectGrid } from "./grid.js";
import { mountPlugins } from "./plugins/index.js";

const NAME_KEY = "meet-name";

function storedName() {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
}

function storeName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // storage unavailable: the name is just not remembered
  }
}

function emitter() {
  const listeners = new Set();
  return {
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(...args) {
      for (const fn of [...listeners]) {
        try {
          fn(...args);
        } catch (err) {
          console.error("meet listener failed", err);
        }
      }
    },
  };
}

function respondentsText(n) {
  return n === 0 ? "No responses yet" : n === 1 ? "1 person responded" : `${n} people responded`;
}

export async function mountView(root, id) {
  const status = el("p", { id: "meet-status", textContent: "Loading…" });
  status.setAttribute("role", "status");
  root.append(status);
  let event;
  try {
    event = await getEvent(id);
  } catch (err) {
    status.textContent = err.status === 404 ? "Event not found" : err.message;
    return;
  }
  status.remove();

  const changes = emitter();
  const hovers = emitter();
  const saves = emitter();

  const titleText = el("h2", { id: "meet-title-text", textContent: event.title });
  const tzNote = el("p", { id: "meet-tz-note", textContent: `Times are in ${event.timezone}` });
  const tools = el("div", { id: "meet-tools" });

  const mine = mountSelectGrid(event, { onEdit: () => setStatus("Unsaved changes") });
  const name = el("input", { id: "meet-name", type: "text", maxLength: 40, value: storedName() });
  const save = el("button", { id: "meet-save", type: "button", textContent: "Save" });
  const withdraw = el("button", { id: "meet-withdraw", type: "button", textContent: "Withdraw", hidden: true });
  const saveStatus = el("p", { id: "meet-save-status" });
  saveStatus.setAttribute("role", "status");
  const setStatus = (text) => {
    saveStatus.textContent = text;
  };

  const heatmap = mountHeatmap(event, { onHover: (index) => hovers.emit(index) });
  const respondents = el("p", { id: "meet-respondents" });
  const legend = el("div", { id: "meet-legend" });
  const side = el("aside", { id: "meet-side" });

  const view = el(
    "div",
    { id: "meet-view" },
    titleText,
    tzNote,
    tools,
    el(
      "div",
      { className: "meet-panels" },
      el(
        "section",
        { className: "meet-panel" },
        el("h3", {}, "Your availability"),
        el("label", {}, "Your name ", name),
        mine.table,
        el("div", { className: "meet-actions" }, save, withdraw),
        saveStatus,
      ),
      el("section", { className: "meet-panel" }, el("h3", {}, "Group availability"), respondents, heatmap.table, legend, side),
    ),
  );
  root.append(view);

  const syncSave = () => {
    save.disabled = name.value.trim() === "";
  };
  name.addEventListener("input", () => {
    syncSave();
    setStatus("Unsaved changes");
  });
  syncSave();

  function renderGroup() {
    const total = event.participants.length;
    respondents.textContent = respondentsText(total);
    heatmap.update(event);
    legend.replaceChildren(
      el("span", { textContent: `0/${total}` }),
      el("span", { className: "meet-legend-bar" }),
      el("span", { textContent: `${total}/${total} available` }),
    );
    withdraw.hidden = !event.me;
  }

  function fillMine() {
    const me = event.participants.find((p) => p.id === event.me);
    if (!me) return;
    name.value = me.name;
    mine.set(me.slots);
    syncSave();
  }

  const ctx = {
    root: view,
    toolbar: tools,
    side,
    getEvent: () => event,
    setEvent(next) {
      event = { ...next, me: next.me === undefined ? event.me : next.me };
      renderGroup();
      changes.emit(event);
    },
    onChange: changes.on,
    onHover: hovers.on,
    onSave: saves.on,
  };

  async function doSave() {
    const nameValue = name.value.trim();
    if (!nameValue) return;
    try {
      const next = await saveAvailability(id, nameValue, mine.selection);
      storeName(nameValue);
      ctx.setEvent(next);
      setStatus("Saved");
      saves.emit(event);
    } catch (err) {
      setStatus(err.message);
    }
  }
  save.addEventListener("click", doSave);
  withdraw.addEventListener("click", async () => {
    try {
      await withdrawAvailability(id);
      mine.set([]);
      const participants = event.participants.filter((p) => p.id !== event.me);
      const gone = new Set(event.participants.filter((p) => p.id === event.me).flatMap((p) => p.slots));
      const counts = event.counts.map((c, i) => (gone.has(i) ? c - 1 : c));
      ctx.setEvent({ ...event, participants, counts, me: null });
      setStatus("");
    } catch (err) {
      setStatus(err.message);
    }
  });

  renderGroup();
  fillMine();
  window.__meet = {
    get event() {
      return ctx.getEvent();
    },
    get selection() {
      return mine.selection;
    },
    select(indices) {
      mine.set(indices);
    },
    save: doSave,
    ctx,
  };
  mountPlugins(ctx);
}
