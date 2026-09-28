import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderNotFound } from "./layout.js";

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "static");
const STATIC_PREFIX = "/static/";
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

async function serveStatic(rawPath, res) {
  let relative;
  try {
    relative = decodeURIComponent(rawPath.slice(STATIC_PREFIX.length));
  } catch {
    return false;
  }
  const file = path.resolve(STATIC_DIR, relative);
  const type = CONTENT_TYPES[path.extname(file)];
  if (!type || !file.startsWith(STATIC_DIR + path.sep)) return false;
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": type });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export async function handleRequest(req, res, pages) {
  const rawPath = (req.url || "/").split(/[?#]/)[0];
  if (Object.hasOwn(pages, rawPath)) return sendHtml(res, 200, pages[rawPath]());
  if (rawPath.startsWith(STATIC_PREFIX) && (await serveStatic(rawPath, res))) return;
  sendHtml(res, 404, renderNotFound());
}
