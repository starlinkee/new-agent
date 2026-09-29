import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { send } from "./http.js";

const THREE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "three");
const ROOTS = [
  ["/vendor/three/build/", path.join(THREE_DIR, "build")],
  ["/vendor/three/addons/", path.join(THREE_DIR, "examples", "jsm")],
];

const notFound = (res) => send(res, 404, { error: "not found" });

// Serves the npm package `three` (only .js files) so pages can load it through an import map.
// Resolves true when the request was handled, false for paths outside /vendor/.
export async function handleVendor(req, res) {
  const rawPath = (req.url || "/").split(/[?#]/)[0];
  if (!rawPath.startsWith("/vendor/")) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, { error: "method not allowed" }, { allow: "GET, HEAD" });
    return true;
  }
  const root = ROOTS.find(([prefix]) => rawPath.startsWith(prefix));
  if (!root) return notFound(res), true;
  let relative;
  try {
    relative = decodeURIComponent(rawPath.slice(root[0].length));
  } catch {
    return notFound(res), true;
  }
  const file = path.resolve(root[1], relative);
  if (path.extname(file) !== ".js" || !file.startsWith(root[1] + path.sep)) return notFound(res), true;
  let data;
  try {
    data = await readFile(file);
  } catch {
    return notFound(res), true;
  }
  res.writeHead(200, {
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "public, max-age=86400",
    "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : data);
  return true;
}
