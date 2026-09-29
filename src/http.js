// Shared HTTP helpers for the JSON API features (todos, pixels, ...).

export const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

export class HttpError extends Error {
  constructor(status, message, headers = {}, extra = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
    this.extra = extra;
  }
}

export function send(res, status, body, headers = {}) {
  const base = { "x-content-type-options": "nosniff", ...headers };
  if (body === undefined) {
    res.writeHead(status, base);
    res.end();
    return;
  }
  res.writeHead(status, { ...base, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// Reads a JSON object body. Rejects with HttpError 415 (not JSON), 413 (over maxBytes) or 400 (malformed).
export function readJson(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    return Promise.reject(new HttpError(415, "content-type must be application/json"));
  }
  const tooLarge = () => new HttpError(413, "payload too large", { connection: "close" });
  if (Number(req.headers["content-length"]) > maxBytes) return Promise.reject(tooLarge());
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        fail(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reject(new HttpError(400, "malformed JSON"));
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return reject(new HttpError(400, "body must be a JSON object"));
      }
      resolve(parsed);
    });
    req.on("aborted", () => fail(new HttpError(400, "request aborted")));
    req.on("close", () => fail(new HttpError(400, "request aborted")));
    req.on("error", () => fail(new HttpError(400, "request error")));
  });
}
