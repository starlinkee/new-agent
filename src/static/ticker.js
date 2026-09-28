export const MAX_ENTRIES = 8;

export function formatTime(seconds) {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatEntry(entry) {
  if (entry.kind === "birth") return `Creature #${entry.id} (gen ${entry.generation}) was born`;
  if (entry.kind === "death") {
    return entry.cause === "plague" ? `Creature #${entry.id} died of plague` : `Creature #${entry.id} starved`;
  }
  return entry.text;
}

// Newest entry on top, never more than `max` rows.
export function createTicker(list, max = MAX_ENTRIES) {
  return {
    add(entry) {
      const li = document.createElement("li");
      li.dataset.kind = entry.kind;
      const time = document.createElement("time");
      time.textContent = formatTime(entry.time);
      li.append(time, ` ${formatEntry(entry)}`);
      list.prepend(li);
      while (list.children.length > max) list.lastElementChild.remove();
    },
    // Moves everything queued in world.log into the list.
    drain(world) {
      for (const entry of world.log.splice(0).slice(-max)) this.add(entry);
    },
  };
}
