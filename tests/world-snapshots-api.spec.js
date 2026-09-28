import { test, expect } from "@playwright/test";

const URL = "/api/world/snapshots";

async function save(request, name, data = { creatures: [1, 2] }) {
  const res = await request.post(URL, { data: { name, data } });
  expect(res.status()).toBe(201);
  return res.json();
}

test.describe("world snapshots API", () => {
  test("create/list/get/delete round trip", async ({ request }) => {
    const data = { tick: 7, nested: { a: [1, "b", null] } };
    const created = await save(request, "  first save  ", data);
    expect(created).toEqual({
      id: expect.anything(),
      name: "first save",
      savedAt: expect.any(String),
      size: Buffer.byteLength(JSON.stringify(data)),
    });
    expect(Number.isNaN(Date.parse(created.savedAt))).toBe(false);

    const list = await (await request.get(URL)).json();
    const entry = list.find((s) => s.id === created.id);
    expect(entry).toEqual(created);
    expect(entry).not.toHaveProperty("data");

    const got = await request.get(`${URL}/${created.id}`);
    expect(got.status()).toBe(200);
    expect(await got.json()).toEqual({ ...created, data });

    expect((await request.delete(`${URL}/${created.id}`)).status()).toBe(204);
    expect((await request.get(`${URL}/${created.id}`)).status()).toBe(404);
    expect((await request.delete(`${URL}/${created.id}`)).status()).toBe(404);
  });

  test("unknown and non-numeric ids give 404", async ({ request }) => {
    expect((await request.get(`${URL}/999999`)).status()).toBe(404);
    expect((await request.get(`${URL}/abc`)).status()).toBe(404);
  });

  test("name validation", async ({ request }) => {
    for (const name of [undefined, "", "   ", 5, "x".repeat(61)]) {
      const res = await request.post(URL, { data: { name, data: {} } });
      expect(res.status()).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
    }
    const ok = await request.post(URL, { data: { name: "x".repeat(60), data: {} } });
    expect(ok.status()).toBe(201);
  });

  test("data must be a JSON object", async ({ request }) => {
    for (const data of [undefined, null, 3, "s", [1]]) {
      const res = await request.post(URL, { data: { name: "n", data } });
      expect(res.status()).toBe(400);
    }
  });

  test("malformed JSON is 400, wrong content type is 415", async ({ request }) => {
    const bad = await request.post(URL, { headers: { "content-type": "application/json" }, data: "{nope" });
    expect(bad.status()).toBe(400);
    const wrong = await request.post(URL, { headers: { "content-type": "text/plain" }, data: "hi" });
    expect(wrong.status()).toBe(415);
  });

  test("oversize data is 413", async ({ request }) => {
    const big = await request.post(URL, { data: { name: "big", data: { blob: "x".repeat(256 * 1024) } } });
    expect(big.status()).toBe(413);
    const huge = await request.post(URL, { data: { name: "huge", data: { blob: "x".repeat(600 * 1024) } } });
    expect(huge.status()).toBe(413);
    const fits = await request.post(URL, { data: { name: "fits", data: { blob: "x".repeat(200 * 1024) } } });
    expect(fits.status()).toBe(201);
  });

  test("oldest snapshots are evicted after 21 saves", async ({ request }) => {
    const first = await save(request, "evict-0");
    for (let i = 1; i <= 20; i++) await save(request, `evict-${i}`);
    const list = await (await request.get(URL)).json();
    expect(list).toHaveLength(20);
    expect(list.find((s) => s.id === first.id)).toBeUndefined();
    expect((await request.get(`${URL}/${first.id}`)).status()).toBe(404);
    expect(list.at(-1).name).toBe("evict-20");
  });

  test("wrong method is 405", async ({ request }) => {
    const put = await request.put(URL, { data: {} });
    expect(put.status()).toBe(405);
    expect(put.headers().allow).toBe("GET, POST");
    const created = await save(request, "m");
    const patch = await request.patch(`${URL}/${created.id}`, { data: {} });
    expect(patch.status()).toBe(405);
    expect(patch.headers().allow).toBe("GET, DELETE");
  });
});
