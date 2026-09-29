import { arena } from "./blobs.js";

const BOT_NAMES = ["Bot Ada", "Bot Bo", "Bot Cy", "Bot Di", "Bot Eli", "Bot Fay", "Bot Gus", "Bot Hal", "Bot Ivy", "Bot Jo", "Bot Kai", "Bot Lu"];
const FLEE_RATIO = 1.25;
const FLEE_RANGE = 300;

// Keeps a few bots in the arena: they chase the nearest food and run from bigger players.
export function startBots(store, { count = 8, maxMass = 24, retargetMs = 200, respawnMs = 2000 } = {}) {
  const bots = new Map(); // player id -> { name, lastTargetAt }
  const timers = new Set();
  let stopped = false;
  let nameCursor = 0;

  function nextName() {
    const taken = new Set([...bots.values()].map((bot) => bot.name));
    for (let i = 0; i < BOT_NAMES.length; i += 1) {
      const name = BOT_NAMES[(nameCursor + i) % BOT_NAMES.length];
      if (!taken.has(name)) {
        nameCursor = (nameCursor + i + 1) % BOT_NAMES.length;
        return name;
      }
    }
    return `Bot ${bots.size + 1}`;
  }

  function spawn() {
    const name = nextName();
    const view = store.join({ name, bot: true, maxMass });
    bots.set(view.id, { name, lastTargetAt: -Infinity });
  }

  function scheduleRespawn() {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) spawn();
    }, respawnMs);
    timer.unref?.();
    timers.add(timer);
  }

  function retarget(view, snapshot) {
    let threat = null;
    let threatDist = FLEE_RANGE;
    for (const other of snapshot.players) {
      if (other.id === view.id || other.mass < FLEE_RATIO * view.mass) continue;
      const dist = Math.hypot(other.x - view.x, other.y - view.y);
      if (dist <= threatDist) {
        threat = other;
        threatDist = dist;
      }
    }
    if (threat) {
      const dx = view.x - threat.x;
      const dy = view.y - threat.y;
      const len = Math.hypot(dx, dy) || 1;
      store.setTarget(view.id, view.x + (dx / len) * FLEE_RANGE, view.y + (dy / len) * FLEE_RANGE);
      return;
    }
    let best = null;
    let bestDist = Infinity;
    for (const [fx, fy] of snapshot.food) {
      const dist = Math.hypot(fx - view.x, fy - view.y);
      if (dist < bestDist) {
        best = [fx, fy];
        bestDist = dist;
      }
    }
    if (best) store.setTarget(view.id, best[0], best[1]);
  }

  function onTick(event) {
    const at = Date.parse(event.at);
    let snapshot = null;
    for (const [id, bot] of bots) {
      if (at - bot.lastTargetAt < retargetMs) continue;
      const view = store.get(id);
      if (!view) continue;
      bot.lastTargetAt = at;
      snapshot ??= store.snapshot();
      retarget(view, snapshot);
    }
  }

  function dropBot(id) {
    if (!bots.delete(id) || stopped) return;
    scheduleRespawn();
  }

  const unsubscribe = store.subscribe((event) => {
    if (event.type === "tick") onTick(event);
    else if (event.type === "eaten") dropBot(event.victim.id);
    else if (event.type === "left") dropBot(event.player.id);
  });

  for (let i = 0; i < count; i += 1) spawn();

  return function stop() {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const id of [...bots.keys()]) store.leave(id);
    bots.clear();
  };
}

export function startDefaultBots() {
  return startBots(arena);
}
