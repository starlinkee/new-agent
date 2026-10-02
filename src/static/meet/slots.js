const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

export function dayLabel(date) {
  return DAY.format(new Date(`${date}T00:00:00Z`));
}

export function slotLabel(event, index) {
  const slot = event.slots[index];
  return `${dayLabel(slot.date)}, ${slot.time}`;
}

function endTime(event, index) {
  const [h, m] = event.slots[index].time.split(":").map(Number);
  const end = h * 60 + m + event.slotMinutes;
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}

export function rangeLabel(event, from, to) {
  return `${dayLabel(event.slots[from].date)}, ${event.slots[from].time}–${endTime(event, to)}`;
}

export function slotEnd(event, index) {
  return new Date(Date.parse(event.slots[index].start) + event.slotMinutes * 60000).toISOString();
}

export function freeAt(event, index) {
  const free = [];
  const busy = [];
  for (const p of event.participants) (p.slots.includes(index) ? free : busy).push(p.name);
  return { free, busy };
}

export function bestBlocks(event, limit = 3) {
  const blocks = [];
  let run = null;
  const flush = () => {
    if (run) blocks.push(run);
    run = null;
  };
  for (let i = 0; i < event.slots.length; i++) {
    const { free, busy } = freeAt(event, i);
    const key = free.join("\u0000");
    const sameRun = run && run.date === event.slots[i].date && run.key === key;
    if (!free.length || !sameRun) flush();
    if (!free.length) continue;
    if (run) run.to = i;
    else run = { from: i, to: i, count: free.length, free, busy, date: event.slots[i].date, key };
  }
  flush();
  return blocks
    .sort((a, b) => b.count - a.count || b.to - b.from - (a.to - a.from) || a.from - b.from)
    .slice(0, limit)
    .map(({ from, to, count, free, busy }) => ({ from, to, count, free, busy }));
}
