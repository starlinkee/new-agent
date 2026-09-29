// The Cloudflare Tunnel (scripts/tunnel.yml) publishes every page on its own subdomain, e.g.
// https://world.viktorbobinski.com. On such a host "/" is that page, and links to the other
// pages point at their own subdomains, since each host serves only its own paths.
const SUBDOMAINS = { home: "/", todos: "/todos", world: "/world", pixels: "/pixels", polls: "/polls", blobs: "/blobs", pulse: "/pulse", biome: "/biome" };
const LINKED = new Map(Object.entries(SUBDOMAINS).map(([name, page]) => [page, name]));

function publicSite(host) {
  const match = /^([a-z]+)\.([a-z0-9-]+(?:\.[a-z0-9-]+)+?)(?::\d+)?$/i.exec(host || "");
  if (!match || !Object.hasOwn(SUBDOMAINS, match[1].toLowerCase())) return null;
  return { page: SUBDOMAINS[match[1].toLowerCase()], domain: match[2].toLowerCase() };
}

export function pagePath(host, rawPath) {
  const site = publicSite(host);
  return site && rawPath === "/" ? site.page : rawPath;
}

export function linkHosts(host, html) {
  const site = publicSite(host);
  if (!site) return html;
  return html.replace(/href="(\/[a-z]*)"/g, (whole, page) =>
    LINKED.has(page) ? `href="https://${LINKED.get(page)}.${site.domain}/"` : whole,
  );
}
