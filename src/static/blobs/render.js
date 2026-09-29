export function computeCamera(state, me, width, height) {
  const scale = me ? Math.max(0.35, Math.min(1, (40 / me.radius) ** 0.5)) : 1;
  const x = me ? me.x : state ? state.width / 2 : 0;
  const y = me ? me.y : state ? state.height / 2 : 0;
  return { x, y, scale, width, height };
}

export function draw(canvas, dpr, state, camera) {
  const c = canvas.getContext("2d");
  const { width, height, scale } = camera;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = "#f4f6f8";
  c.fillRect(0, 0, width, height);
  if (!state) return;
  c.save();
  c.translate(width / 2 - camera.x * scale, height / 2 - camera.y * scale);
  c.scale(scale, scale);

  c.fillStyle = "#ffffff";
  c.fillRect(0, 0, state.width, state.height);
  c.strokeStyle = "rgba(0, 0, 0, 0.08)";
  c.lineWidth = 1 / scale;
  c.beginPath();
  for (let gx = 0; gx <= state.width; gx += 50) {
    c.moveTo(gx, 0);
    c.lineTo(gx, state.height);
  }
  for (let gy = 0; gy <= state.height; gy += 50) {
    c.moveTo(0, gy);
    c.lineTo(state.width, gy);
  }
  c.stroke();
  c.strokeStyle = "#c0392b";
  c.lineWidth = 4 / scale;
  c.strokeRect(0, 0, state.width, state.height);

  c.fillStyle = "#7f8c8d";
  for (const [fx, fy] of state.food) {
    c.beginPath();
    c.arc(fx, fy, 3, 0, Math.PI * 2);
    c.fill();
  }

  c.textAlign = "center";
  c.textBaseline = "middle";
  for (const p of [...state.players].sort((a, b) => a.mass - b.mass)) {
    c.fillStyle = p.color;
    c.beginPath();
    c.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = "rgba(0, 0, 0, 0.25)";
    c.lineWidth = 2 / scale;
    c.stroke();
    const size = Math.max(10 / scale, p.radius * 0.4);
    c.font = `600 ${size}px sans-serif`;
    c.fillStyle = "#fff";
    c.strokeStyle = "rgba(0, 0, 0, 0.6)";
    c.lineWidth = size / 8;
    c.strokeText(p.name, p.x, p.y - size * 0.4);
    c.fillText(p.name, p.x, p.y - size * 0.4);
    const mass = String(Math.round(p.mass));
    c.strokeText(mass, p.x, p.y + size * 0.6);
    c.fillText(mass, p.x, p.y + size * 0.6);
  }
  c.restore();
}
