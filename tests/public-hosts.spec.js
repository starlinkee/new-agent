import { test, expect } from "@playwright/test";

// scripts/tunnel.yml publishes each page on its own subdomain; the tunnel keeps the Host header.
const host = (name) => ({ headers: { host: `${name}.viktorbobinski.com` } });

test("a service subdomain serves its page at the root", async ({ request }) => {
  for (const [name, title] of [["world", "World"], ["pixels", "Pixels"], ["blobs", "Blobs"], ["home", "Hello"]]) {
    const res = await request.get("/", host(name));
    expect(res.status(), name).toBe(200);
    expect(await res.text(), name).toContain(`<title>${title}`);
  }
});

test("on a service subdomain nav links point at the other subdomains", async ({ request }) => {
  const html = await (await request.get("/", host("world"))).text();
  expect(html).toContain('href="https://home.viktorbobinski.com/"');
  expect(html).toContain('href="https://pixels.viktorbobinski.com/"');
  expect(html).toContain('href="https://pulse.viktorbobinski.com/"');
  expect(html).toContain('href="/static/styles.css"');
});

test("localhost keeps relative links and the home page at the root", async ({ request }) => {
  const html = await (await request.get("/")).text();
  expect(html).toContain("<title>Hello");
  expect(html).toContain('href="/world"');
});
