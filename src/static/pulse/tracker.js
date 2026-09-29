(function () {
  var script = document.currentScript;
  var site = script && script.getAttribute("data-site");
  if (!site) return;
  var api = script.getAttribute("data-api") || new URL(script.src).origin;
  var endpoint = api.replace(/\/+$/, "") + "/api/pulse/collect";
  var ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  var memoryId = null;
  var lastPath = null;
  var first = true;

  function randomId() {
    var bytes = crypto.getRandomValues(new Uint8Array(22));
    var id = "";
    for (var i = 0; i < bytes.length; i++) id += ALPHABET[bytes[i] & 63];
    return id;
  }

  function visitor() {
    try {
      var id = localStorage.getItem("pulse_vid");
      if (!id || !/^[A-Za-z0-9_-]{22}$/.test(id)) {
        id = randomId();
        localStorage.setItem("pulse_vid", id);
      }
      return id;
    } catch (err) {
      return (memoryId = memoryId || randomId());
    }
  }

  function send(body) {
    var blob = new Blob([JSON.stringify(body)], { type: "text/plain" });
    var sent = false;
    try {
      sent = !!(navigator.sendBeacon && navigator.sendBeacon(endpoint, blob));
    } catch (err) {}
    if (!sent && window.fetch) {
      fetch(endpoint, { method: "POST", body: blob, headers: { "content-type": "text/plain" }, keepalive: true }).catch(function () {});
    }
  }

  function pageview() {
    if (navigator.doNotTrack === "1") return;
    lastPath = location.pathname;
    var body = { site: site, path: lastPath, visitor: visitor(), width: window.innerWidth };
    if (first) body.referrer = document.referrer;
    first = false;
    send(body);
  }

  function onNavigate() {
    if (location.pathname !== lastPath) pageview();
  }

  ["pushState", "replaceState"].forEach(function (name) {
    var original = history[name];
    history[name] = function () {
      var result = original.apply(this, arguments);
      onNavigate();
      return result;
    };
  });
  window.addEventListener("popstate", onNavigate);

  window.pulse = { pageview: pageview };
  pageview();
})();
