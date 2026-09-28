import { readFileSync } from "node:fs";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const startedAt = Date.now();

export function handleHealth(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET", "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  const uptimeSeconds = (Date.now() - startedAt) / 1000;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "ok", uptimeSeconds, version }));
}
