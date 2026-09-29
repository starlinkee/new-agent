async function request(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `request failed (${res.status})`), { status: res.status });
  return data;
}

const post = (url, body) =>
  request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const listPolls = () => request("/api/polls").then((data) => data.polls);
export const getPoll = (id) => request(`/api/polls/${encodeURIComponent(id)}`);
export const createPoll = (input) => post("/api/polls", input);
export const votePoll = (id, option) => post(`/api/polls/${encodeURIComponent(id)}/vote`, { option });
