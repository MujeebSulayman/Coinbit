import assert from "node:assert/strict";
import { test } from "node:test";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
function fakeFetch(replies: Reply[], seen: string[]) {
  return (async (url: string) => {
    seen.push(String(url));
    const r = replies.shift() ?? { status: 200, body: {} };
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {}), { status: r.status, headers: r.headers });
  }) as typeof fetch;
}

test("a 429 is retried after the window resets, and never reported as 'no route'", async () => {
  const seen: string[] = [];
  const reset = String(Math.ceil(Date.now() / 1000) + 1);
  globalThis.fetch = fakeFetch(
    [
      { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } },
      { status: 200, body: { outAmount: "1000000" }, headers: { "x-ratelimit-remaining": "4" } },
    ],
    seen,
  );
  const { jupGet } = await import("../lib/jupiter");
  const t0 = Date.now();
  const r = await jupGet<{ outAmount: string }>("/swap/v1/quote?x=1");
  assert.equal(r.ok, true);
  assert.equal(seen.length, 2);
  assert.ok(Date.now() - t0 >= 300, "waited for the reset before retrying");
});

test("persistent 429 → 'rate-limited'; 400 no route → 'no-route'", async () => {
  const { jupGet } = await import("../lib/jupiter");
  globalThis.fetch = fakeFetch([{ status: 429 }, { status: 429 }], []);
  const a = await jupGet("/x", { tries: 2 });
  assert.deepEqual(a, { ok: false, reason: "rate-limited", status: 429 });
  globalThis.fetch = fakeFetch([{ status: 400, body: '{"error":"Could not find any route"}' }], []);
  const b = await jupGet("/x");
  assert.deepEqual(b, { ok: false, reason: "no-route", status: 400 });
});

test("roundTrip: rate-limited sell quote = unknown (null), not 'unsellable'", async () => {
  const { roundTrip } = await import("../lib/market");
  globalThis.fetch = fakeFetch([{ status: 200, body: { outAmount: "1000000000" } }, { status: 429 }, { status: 429 }, { status: 429 }], []);
  assert.equal(await roundTrip("Mint111", 0.1), null);
  globalThis.fetch = fakeFetch([{ status: 200, body: { outAmount: "1000000000" } }, { status: 200, body: { outAmount: "95000000" } }], []);
  const ok = await roundTrip("Mint111", 0.1);
  assert.equal(ok?.sellable, true);
  assert.ok(Math.abs(ok!.lossPct - 5) < 1e-9);
});
