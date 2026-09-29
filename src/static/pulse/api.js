export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(url, options) {
  const res = await fetch(url, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON body: fall through to the status handling below
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `request failed (${res.status})`);
  return data;
}

export const listSites = () => request("/api/pulse/sites");

export const getSite = (id) => request(`/api/pulse/sites/${encodeURIComponent(id)}`);

export const getSummary = (id, range) =>
  request(`/api/pulse/sites/${encodeURIComponent(id)}/summary?range=${encodeURIComponent(range)}`);

export const createSite = (body) =>
  request("/api/pulse/sites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
