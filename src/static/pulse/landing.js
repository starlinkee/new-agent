import { createSite, listSites } from "./api.js";
import { el } from "./format.js";

function siteCard(site) {
  return el(
    "a",
    { class: "pulse-site-link", href: `/pulse?site=${encodeURIComponent(site.id)}` },
    el("strong", { text: site.name }),
    el("span", { text: site.domain || "No domain" }),
  );
}

async function showSites(list) {
  try {
    const { sites } = await listSites();
    list.replaceChildren(...sites.map(siteCard));
    if (!sites.length) list.append(el("p", { class: "pulse-empty", text: "No sites yet. Add your first one above." }));
  } catch (err) {
    list.replaceChildren(el("p", { class: "pulse-empty", text: err.message }));
  }
}

export function mountLanding(root) {
  const name = el("input", { id: "pulse-site-name", name: "name", type: "text", required: true, autocomplete: "off" });
  const domain = el("input", { id: "pulse-site-domain", name: "domain", type: "text", placeholder: "example.com", autocomplete: "off" });
  const submit = el("button", { id: "pulse-site-create", type: "submit", text: "Create site" });
  const error = el("p", { id: "pulse-site-error", role: "alert" });
  const form = el(
    "form",
    { id: "pulse-site-form" },
    el("label", {}, "Site name", name),
    el("label", {}, "Domain", domain),
    submit,
  );
  const sites = el("div", { id: "pulse-sites" });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.textContent = "";
    submit.disabled = true;
    const body = { name: name.value };
    if (domain.value.trim()) body.domain = domain.value;
    try {
      const site = await createSite(body);
      location.assign(`/pulse?site=${encodeURIComponent(site.id)}`);
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  });

  root.replaceChildren(
    el("div", { class: "pulse-hero" }, el("h1", { text: "Pulse" }), el("p", { class: "pulse-tagline", text: "Simple, privacy-friendly analytics for your sites." })),
    el("section", { class: "pulse-panel" }, el("h2", { text: "Add a site" }), form, error),
    el("h2", { class: "pulse-section-title", text: "Your sites" }),
    sites,
  );
  showSites(sites);
}
