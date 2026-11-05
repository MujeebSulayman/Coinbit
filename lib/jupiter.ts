/**
 * Every Jupiter API call goes through here: one queue, paced by Jupiter's own rate-limit headers.
 *
 * Why: the keyless endpoint (lite-api.jup.ag) allows ~5 requests per 10s per IP (measured 2026-11-05;
 * Jupiter's docs say 0.5 rps keyless, 1 rps with a free key from portal.jup.ag). Our three strategies
 * need more than that, and a refused request (HTTP 429) used to look exactly like "no route": coins were
 * skipped as unsellable, and a paper buy once filled at a stale price. Kaiser.charon's fix log
 * (2026-10-23) describes the same failure ("quoting dark ~28% of the day") and the same cure: a key,
 * and a header-aware governor instead of blind retries.
 *
 * Results say *why* a call failed, so callers never mistake "rate limited" for "no route".
 */
import { config } from "./config";

export type JupResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "no-route" | "rate-limited" | "error"; status?: number };

const base = () => (config.jupiterApiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag");

type Job = { run: () => Promise<void> };
const queues: { high: Job[]; low: Job[] } = { high: [], low: [] };
let running = false;
let remaining = 1; // requests left in Jupiter's current window (from x-ratelimit-remaining)
let resetAt = 0; // when the window resets, ms (from x-ratelimit-reset, epoch seconds)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pump() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = queues.high.shift() ?? queues.low.shift();
      if (!job) return;
      if (remaining <= 0 && Date.now() < resetAt) await sleep(resetAt - Date.now() + 50);
      await job.run();
    }
  } finally {
    running = false;
  }
}

function readLimits(res: Response) {
  const rem = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(rem)) remaining = rem;
  if (Number.isFinite(reset) && reset > 0) resetAt = reset * 1000;
}

/**
 * GET a Jupiter path (e.g. "/swap/v1/quote?…"). `priority: "high"` jumps the queue: exits and the prices
 * of open positions go before research checks. Retries 429s after the window resets (up to `tries`).
 */
export function jupGet<T>(path: string, opts: { priority?: "high" | "low"; timeoutMs?: number; tries?: number } = {}): Promise<JupResult<T>> {
  const { priority = "low", timeoutMs = 6000, tries = 3 } = opts;
  return new Promise((resolve) => {
    let attempt = 0;
    const job: Job = {
      run: async () => {
        attempt++;
        try {
          const res = await fetch(`${base()}${path}`, {
            headers: { accept: "application/json", ...(config.jupiterApiKey ? { "x-api-key": config.jupiterApiKey } : {}) },
            signal: AbortSignal.timeout(timeoutMs),
          });
          readLimits(res);
          if (res.status === 429) {
            remaining = 0;
            if (resetAt < Date.now()) resetAt = Date.now() + 2000;
            if (attempt < tries) return void queues[priority].unshift(job); // retried after the reset
            return resolve({ ok: false, reason: "rate-limited", status: 429 });
          }
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            // Jupiter answers 400 "Could not find any route" / "TOKEN_NOT_TRADABLE" when there's no market.
            const noRoute = res.status === 400 && /route|not tradable|TOKEN_NOT_TRADABLE/i.test(body);
            return resolve({ ok: false, reason: noRoute ? "no-route" : "error", status: res.status });
          }
          resolve({ ok: true, data: (await res.json()) as T });
        } catch {
          resolve({ ok: false, reason: "error" });
        }
      },
    };
    queues[priority].push(job);
    void pump();
  });
}

/** POST (swap transaction building, live mode only). Same queue, always high priority. */
export function jupPost<T>(path: string, body: unknown, timeoutMs = 10_000): Promise<JupResult<T>> {
  return new Promise((resolve) => {
    queues.high.push({
      run: async () => {
        try {
          const res = await fetch(`${base()}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(config.jupiterApiKey ? { "x-api-key": config.jupiterApiKey } : {}) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
          readLimits(res);
          if (res.status === 429) return resolve({ ok: false, reason: "rate-limited", status: 429 });
          if (!res.ok) return resolve({ ok: false, reason: "error", status: res.status });
          resolve({ ok: true, data: (await res.json()) as T });
        } catch {
          resolve({ ok: false, reason: "error" });
        }
      },
    });
    void pump();
  });
}

/** For the heartbeat / debugging. */
export const jupQueueDepth = () => queues.high.length + queues.low.length;
