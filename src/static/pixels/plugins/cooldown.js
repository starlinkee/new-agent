// Shows the remaining paint tokens in #pixels-cooldown and, after a 429, "Wait Ns" while painting is disabled.
// Painting is disabled by making the canvas ignore pointer input until the server's retryAfterMs has elapsed.

export function mount({ canvas, toolbar }) {
  const label = document.createElement("span");
  label.id = "pixels-cooldown";
  label.setAttribute("role", "status");
  toolbar.append(label);

  let timer = null;

  function enable() {
    clearInterval(timer);
    timer = null;
    canvas.style.pointerEvents = "";
    canvas.removeAttribute("aria-disabled");
  }

  function cooldown(retryAfterMs) {
    enable();
    const until = Date.now() + retryAfterMs;
    canvas.style.pointerEvents = "none";
    canvas.setAttribute("aria-disabled", "true");
    label.dataset.state = "waiting";
    const tick = () => {
      const left = until - Date.now();
      if (left <= 0) {
        enable();
        label.dataset.state = "ready";
        label.textContent = "Ready to paint";
        return;
      }
      label.textContent = `Wait ${Math.ceil(left / 1000)}s`;
    };
    tick();
    if (until > Date.now()) timer = setInterval(tick, 200);
  }

  async function inspect(res) {
    if (res.status === 429) {
      let retryAfterMs = Number(res.headers.get("retry-after")) * 1000;
      try {
        const body = await res.clone().json();
        if (Number.isFinite(body.retryAfterMs)) retryAfterMs = body.retryAfterMs;
      } catch {}
      cooldown(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 1000);
    } else if (res.ok) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining !== null && !timer) {
        label.dataset.state = "tokens";
        label.textContent = `Paints left: ${remaining}`;
      }
    }
  }

  // The page's paint request goes through fetch; observe its POST responses.
  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await originalFetch.call(this, input, init);
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href);
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "POST" && url.pathname === "/api/pixels") await inspect(res);
    return res;
  };

  return () => {
    window.fetch = originalFetch;
    enable();
    label.remove();
  };
}
