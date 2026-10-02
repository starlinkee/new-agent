import { dayLabel, slotLabel } from "./slots.js";

export function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// Builds the table for an event: one column per date, one row per time of day. Returns the table
// and the cells indexed by slot.
export function buildGrid(event, { id, label }) {
  const table = el("table", { id, className: "meet-grid" });
  table.setAttribute("aria-label", label);
  const cells = [];
  const head = el("tr", {}, el("th", { scope: "col" }));
  for (const date of event.dates) head.append(el("th", { scope: "col", textContent: dayLabel(date) }));
  table.append(el("thead", {}, head));
  const body = el("tbody");
  for (let k = 0; k < event.slotsPerDay; k++) {
    const first = event.slots[k];
    const row = el("tr", {}, el("th", { scope: "row", className: "meet-time", textContent: first.time.endsWith(":00") ? first.time : "" }));
    for (let d = 0; d < event.dates.length; d++) {
      const index = d * event.slotsPerDay + k;
      const cell = el("button", { type: "button", className: "meet-cell" });
      cell.dataset.slot = String(index);
      cell.setAttribute("aria-label", slotLabel(event, index));
      cells[index] = cell;
      row.append(el("td", {}, cell));
    }
    body.append(row);
  }
  table.append(body);
  return { table, cells };
}

// Drag-to-select: pressing a cell picks the mode from that cell, entering cells while pressed applies it.
export function mountSelectGrid(event, { onEdit }) {
  const { table, cells } = buildGrid(event, { id: "meet-mine-grid", label: "Your availability" });
  const selected = new Set();
  let mode = null;
  let last = null;

  // A fast pointer can skip cells between two events: fill the gap when both cells share a date column.
  function paintTo(index) {
    const sameDay = last !== null && Math.floor(last / event.slotsPerDay) === Math.floor(index / event.slotsPerDay);
    const [lo, hi] = sameDay ? [Math.min(last, index), Math.max(last, index)] : [index, index];
    for (let i = lo; i <= hi; i++) paint(i, mode);
    last = index;
  }

  function paint(index, on) {
    if (selected.has(index) === on) return;
    if (on) selected.add(index);
    else selected.delete(index);
    cells[index].classList.toggle("selected", on);
    cells[index].setAttribute("aria-pressed", String(on));
    onEdit();
  }
  function setAll(indices) {
    selected.clear();
    cells.forEach((cell) => {
      cell.classList.remove("selected");
      cell.setAttribute("aria-pressed", "false");
    });
    for (const i of indices) {
      if (!cells[i]) continue;
      selected.add(i);
      cells[i].classList.add("selected");
      cells[i].setAttribute("aria-pressed", "true");
    }
  }
  const cellOf = (target) => target.closest?.(".meet-cell");
  const indexOf = (cell) => Number(cell.dataset.slot);

  cells.forEach((cell) => cell.setAttribute("aria-pressed", "false"));
  table.addEventListener("pointerdown", (e) => {
    const cell = cellOf(e.target);
    if (!cell || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.preventDefault();
    table.releasePointerCapture?.(e.pointerId);
    mode = !selected.has(indexOf(cell));
    last = null;
    paintTo(indexOf(cell));
    cell.focus();
  });
  table.addEventListener("pointerover", (e) => {
    const cell = cellOf(e.target);
    if (mode !== null && cell) paintTo(indexOf(cell));
  });
  // Touch pointers are captured by the pressed cell, so pointerover never fires on the others.
  table.addEventListener("pointermove", (e) => {
    if (mode === null || e.pointerType === "mouse") return;
    const cell = cellOf(document.elementFromPoint(e.clientX, e.clientY));
    if (cell && table.contains(cell)) paintTo(indexOf(cell));
  });
  const end = () => {
    mode = null;
    last = null;
  };
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
  table.addEventListener("keydown", (e) => {
    const cell = cellOf(e.target);
    if (!cell || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    paint(indexOf(cell), !selected.has(indexOf(cell)));
  });
  table.addEventListener("click", (e) => {
    if (e.detail === 0 && cellOf(e.target)) e.preventDefault();
  });

  return {
    table,
    get selection() {
      return [...selected].sort((a, b) => a - b);
    },
    set: setAll,
    destroy() {
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
    },
  };
}

export function mountHeatmap(event, { onHover }) {
  const { table, cells } = buildGrid(event, { id: "meet-group-grid", label: "Group availability" });
  let hovered = null;
  const hover = (value) => {
    if (value === hovered) return;
    hovered = value;
    onHover(value);
  };
  const slotOf = (target) => {
    const cell = target.closest?.(".meet-cell");
    return cell ? Number(cell.dataset.slot) : null;
  };
  table.addEventListener("pointerover", (e) => {
    const slot = slotOf(e.target);
    if (slot !== null) hover(slot);
  });
  table.addEventListener("pointerleave", () => hover(null));
  table.addEventListener("focusin", (e) => {
    const slot = slotOf(e.target);
    if (slot !== null) hover(slot);
  });
  table.addEventListener("focusout", (e) => {
    if (!table.contains(e.relatedTarget)) hover(null);
  });
  return {
    table,
    update(next) {
      const total = next.participants.length;
      cells.forEach((cell, i) => {
        const count = next.counts[i] ?? 0;
        cell.dataset.count = String(count);
        cell.style.setProperty("--level", String(total ? count / total : 0));
        cell.classList.toggle("everyone", total > 0 && count === total);
        cell.setAttribute("aria-label", `${slotLabel(next, i)}: ${count} of ${total} available`);
      });
    },
  };
}
