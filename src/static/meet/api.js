async function request(url, options) {
  const res = await fetch(url, options);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `request failed (${res.status})`), { status: res.status });
  return data;
}

const send = (method, url, body) =>
  request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const eventUrl = (id) => `/api/meet/${encodeURIComponent(id)}`;

export const createEvent = (input) => send("POST", "/api/meet", input);
export const getEvent = (id) => request(eventUrl(id));
export const saveAvailability = (id, name, slots) => send("PUT", `${eventUrl(id)}/availability`, { name, slots });
export const withdrawAvailability = (id) => request(`${eventUrl(id)}/availability`, { method: "DELETE" });
