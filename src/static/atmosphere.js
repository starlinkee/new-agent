const DAY_SECONDS = 60;
const MAX_PARTICLES = 300;
const HALO_SIZE = 64;
const GLOW_MIN_DARKNESS = 0.4; // glows fade in around dusk and out by dawn, never at midday
const WEATHER_ORDER = ["clear", "rain", "snow"];

// Time of day is a fraction of the cycle: 0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk.
const SKY_STOPS = [
  [0, [8, 12, 32]],
  [0.2, [12, 18, 44]],
  [0.27, [240, 140, 100]],
  [0.35, [120, 190, 240]],
  [0.5, [110, 195, 255]],
  [0.65, [120, 190, 240]],
  [0.73, [230, 110, 90]],
  [0.8, [14, 18, 46]],
  [1, [8, 12, 32]],
];
const PHASES = [
  [0.2, "night"],
  [0.3, "dawn"],
  [0.7, "day"],
  [0.8, "dusk"],
  [1.01, "night"],
];

function lerpColor(t) {
  for (let i = 1; i < SKY_STOPS.length; i++) {
    const [t1, c1] = SKY_STOPS[i];
    if (t <= t1) {
      const [t0, c0] = SKY_STOPS[i - 1];
      const k = (t - t0) / (t1 - t0);
      return c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
    }
  }
  return SKY_STOPS[SKY_STOPS.length - 1][1];
}

function darkness(t) {
  // 1 at midnight, 0 at noon, smooth in between.
  return (1 + Math.cos(t * Math.PI * 2)) / 2;
}

export function createAtmosphere({ random = Math.random } = {}) {
  let time = 0.3;
  let weather = "clear";
  let weatherLeft = 10 + random() * 15;
  const particles = [];

  const duration = () => 10 + random() * 15;

  function setWeather(next) {
    if (!WEATHER_ORDER.includes(next)) throw new Error(`unknown weather: ${next}`);
    weather = next;
    weatherLeft = duration();
    particles.length = 0;
  }

  function spawn(w) {
    const snow = weather === "snow";
    particles.push({
      x: random() * w,
      y: -5,
      vx: snow ? (random() - 0.5) * 30 : -40,
      vy: snow ? 40 + random() * 40 : 500 + random() * 200,
      size: snow ? 1.5 + random() * 2 : 1,
    });
  }

  function update(dt, w = 800, h = 600) {
    time = (time + dt / DAY_SECONDS) % 1;
    weatherLeft -= dt;
    if (weatherLeft <= 0) {
      setWeather(WEATHER_ORDER[(WEATHER_ORDER.indexOf(weather) + 1) % WEATHER_ORDER.length]);
    }
    if (weather !== "clear") {
      const target = weather === "rain" ? MAX_PARTICLES : MAX_PARTICLES / 2;
      for (let i = 0; i < 8 && particles.length < target; i++) spawn(w);
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.y > h || p.x < -10 || p.x > w + 10) {
        // Recycle in place so the pool never grows past its cap.
        p.x = random() * w;
        p.y = -5;
      }
    }
  }

  function drawSky(ctx, w, h) {
    const [r, g, b] = lerpColor(time);
    ctx.fillStyle = `rgb(${r} ${g} ${b})`;
    ctx.fillRect(0, 0, w, h);
    // Sun by day, moon by night, each following an arc across the sky.
    const sunT = (time - 0.25) * 2; // 0..1 while the sun is up (dawn to dusk)
    const moonT = ((time + 0.5) % 1 - 0.25) * 2;
    for (const [t, color, radius] of [[sunT, "#ffe27a", 22], [moonT, "#e8ecff", 16]]) {
      if (t < 0 || t > 1) continue;
      const x = w * t;
      const y = h * 0.85 - Math.sin(t * Math.PI) * h * 0.7;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawWeather(ctx) {
    if (!particles.length) return;
    if (weather === "rain") {
      ctx.strokeStyle = "rgba(170,200,255,0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const p of particles) {
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.vx * 0.03, p.y + p.vy * 0.03);
      }
      ctx.stroke();
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      for (const p of particles) {
        ctx.moveTo(p.x + p.size, p.y);
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  // Soft halo so creatures and food stay visible in the dark. The halo is
  // rendered once per color into an offscreen canvas and stamped with drawImage.
  const halos = new Map();
  function halo(color) {
    let canvas = halos.get(color);
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.width = canvas.height = HALO_SIZE;
      const g = canvas.getContext("2d");
      const c = HALO_SIZE / 2;
      const grad = g.createRadialGradient(c, c, 0, c, c, c);
      grad.addColorStop(0, `rgba(${color},1)`);
      grad.addColorStop(1, `rgba(${color},0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, HALO_SIZE, HALO_SIZE);
      halos.set(color, canvas);
    }
    return canvas;
  }

  function drawGlow(ctx, x, y, radius, color = "255,240,180") {
    const d = darkness(time);
    if (d < GLOW_MIN_DARKNESS) return;
    const r = radius * 3;
    ctx.globalAlpha = 0.6 * d;
    ctx.drawImage(halo(color), x - r, y - r, r * 2, r * 2);
    ctx.globalAlpha = 1;
  }

  return {
    update,
    draw(ctx, w, h) {
      drawSky(ctx, w, h);
    },
    drawWeather,
    drawGlow,
    phase() {
      return PHASES.find(([end]) => time < end)[1];
    },
    weather: () => weather,
    time: () => time,
    setTime(t) {
      time = ((t % 1) + 1) % 1;
    },
    setWeather,
    particleCount: () => particles.length,
    particleVelocities: () => particles.map((p) => p.vy),
  };
}
