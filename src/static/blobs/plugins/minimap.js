const SIZE = 150;
const THREAT_RATIO = 1.25;

function isTyping(target) {
  return target instanceof Element && (target.closest("input, textarea, select") !== null || target.isContentEditable);
}

export function mount(ctx) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./minimap.css", import.meta.url).href;
  document.head.append(link);

  const tool = document.createElement("div");
  tool.className = "blobs-tool";
  tool.dataset.plugin = "minimap";
  const canvas = document.createElement("canvas");
  canvas.id = "blobs-minimap";
  tool.append(canvas);
  ctx.hud.append(tool);

  function draw(state) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(SIZE * dpr);
    canvas.height = Math.round(SIZE * dpr);
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#111";
    c.fillRect(0, 0, SIZE, SIZE);
    if (!state) return;

    const sx = SIZE / state.width;
    const sy = SIZE / state.height;
    const me = ctx.getMe();

    const cam = ctx.getCamera();
    c.strokeStyle = "#ffffff";
    c.lineWidth = 1;
    c.strokeRect(
      (cam.x - cam.width / 2 / cam.scale) * sx + 0.5,
      (cam.y - cam.height / 2 / cam.scale) * sy + 0.5,
      (cam.width / cam.scale) * sx,
      (cam.height / cam.scale) * sy,
    );

    for (const p of state.players) {
      if (me && p.id === me.id) continue;
      c.fillStyle = me && p.mass >= THREAT_RATIO * me.mass ? "#e53935" : "#888";
      c.beginPath();
      c.arc(p.x * sx, p.y * sy, 2, 0, Math.PI * 2);
      c.fill();
    }

    if (me) {
      c.fillStyle = "#ffffff";
      c.beginPath();
      c.arc(me.x * sx, me.y * sy, 3, 0, Math.PI * 2);
      c.fill();
    }
  }

  function onKey(e) {
    if (e.key !== "m" || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    canvas.hidden = !canvas.hidden;
  }

  draw(ctx.getState());
  const stop = ctx.onState(draw);
  document.addEventListener("keydown", onKey);

  return () => {
    stop();
    document.removeEventListener("keydown", onKey);
    tool.remove();
    link.remove();
  };
}
