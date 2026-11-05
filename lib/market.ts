import { jupGet, type JupResult } from "./jupiter";
import { getBondingCurves, PUMP_DECIMALS, PUMP_TOTAL_SUPPLY, WSOL } from "./solana";

export type DexPair = {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  pairCreatedAt?: number;
  txns?: { m5?: { buys: number; sells: number } };
  volume?: { m5?: number };
};

async function getJson<T>(url: string, timeoutMs = 10_000): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

let solUsdCache = { v: 0, at: 0 };
export async function solUsd(): Promise<number> {
  if (Date.now() - solUsdCache.at < 60_000 && solUsdCache.v > 0) return solUsdCache.v;
  const r = await jupGet<Record<string, { usdPrice?: number }>>(`/price/v3?ids=${WSOL}`, { tries: 1 });
  let v = r.ok ? (r.data[WSOL]?.usdPrice ?? 0) : 0;
  if (!v) {
    const pairs = await dexPairs([WSOL]);
    v = Number(pairs.get(WSOL)?.priceUsd ?? 0);
  }
  if (v > 0) solUsdCache = { v, at: Date.now() };
  return v || solUsdCache.v || 150;
}

/** Best (most liquid) DexScreener pair per token. */
export async function dexPairs(mints: string[]): Promise<Map<string, DexPair>> {
  const out = new Map<string, DexPair>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const pairs = await getJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${chunk.join(",")}`);
    for (const p of pairs ?? []) {
      const m = p.baseToken.address;
      const cur = out.get(m);
      if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) out.set(m, p);
    }
  }
  return out;
}

export type Quote = {
  mint: string;
  priceSol: number;
  mcapUsd: number;
  onCurve: boolean;
  /** On a pump.fun curve that isn't SOL-quoted: priced from the market instead. */
  nonStandard?: boolean;
  /** Trades in a pool quoted in another token (e.g. CARDS), not SOL: priceSol is converted from USD. */
  nonSolPool?: string;
  /** Bonding-curve details (only while on the curve). */
  curve?: { progressPct: number; vSol: number; creator: string | null };
  liquidityUsd?: number;
  symbol?: string;
  name?: string;
  pairCreatedAt?: number;
};

/** Price in SOL + market cap. Uses the pump.fun bonding curve directly when the coin hasn't migrated. */
export async function quotes(mints: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (mints.length === 0) return out;
  const [curves, sol] = await Promise.all([getBondingCurves(mints).catch(() => new Map()), solUsd()]);
  const needDex: string[] = [];
  for (const m of mints) {
    const bc = curves.get(m);
    if (bc && !bc.complete && bc.priceSol > 0 && bc.standard) {
      out.set(m, {
        mint: m,
        priceSol: bc.priceSol,
        mcapUsd: bc.priceSol * PUMP_TOTAL_SUPPLY * sol,
        onCurve: true,
        curve: { progressPct: bc.progressPct, vSol: Number(bc.virtualSolReserves) / 1e9, creator: bc.creator },
      });
    } else needDex.push(m);
  }
  if (needDex.length) {
    const pairs = await dexPairs(needDex);
    for (const m of needDex) {
      const p = pairs.get(m);
      if (!p) continue;
      let priceSol = 0;
      if (p.quoteToken.address === WSOL) priceSol = Number(p.priceNative ?? 0);
      else if (p.priceUsd) priceSol = Number(p.priceUsd) / sol;
      out.set(m, {
        mint: m,
        nonStandard: !!(curves.get(m) && !curves.get(m)!.complete && !curves.get(m)!.standard),
        nonSolPool: p.quoteToken.address === WSOL ? undefined : p.quoteToken.symbol,
        priceSol,
        mcapUsd: p.marketCap ?? p.fdv ?? 0,
        onCurve: false,
        liquidityUsd: p.liquidity?.usd,
        symbol: p.baseToken.symbol,
        name: p.baseToken.name,
        pairCreatedAt: p.pairCreatedAt,
      });
    }
  }
  return out;
}

/* ---------------- Jupiter quotes (executable prices) ---------------- */

type Priority = "high" | "low";
type BuyQuote = { tokens: number; priceSol: number; impactPct: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What `sol` buys right now, or why not ("no-route" vs "rate-limited" vs "error"). `retryNoRoute`
 * re-asks a few times 700ms apart: a coin that just graduated is often not routable for a moment
 * (Kaiser.charon measured hundreds of false rejections a day without this).
 */
export async function jupBuy(mint: string, sol: number, opts: { priority?: Priority; retryNoRoute?: number } = {}): Promise<JupResult<BuyQuote>> {
  for (let i = 0; ; i++) {
    const r = await jupGet<{ outAmount?: string; priceImpactPct?: string }>(
      `/swap/v1/quote?inputMint=${WSOL}&outputMint=${mint}&amount=${Math.floor(sol * 1e9)}&slippageBps=1500`,
      { priority: opts.priority },
    );
    if (r.ok) {
      const tokens = Number(r.data.outAmount ?? 0) / 10 ** PUMP_DECIMALS;
      if (tokens > 0) return { ok: true, data: { tokens, priceSol: sol / tokens, impactPct: Number(r.data.priceImpactPct ?? 0) * 100 } };
      if (i >= (opts.retryNoRoute ?? 0)) return { ok: false, reason: "no-route" };
    } else if (r.reason !== "no-route" || i >= (opts.retryNoRoute ?? 0)) return r;
    await sleep(700);
  }
}

/** What `sol` buys right now (null if it can't be quoted, for any reason). */
export async function jupBuyQuote(mint: string, sol: number, priority: Priority = "low"): Promise<BuyQuote | null> {
  const r = await jupBuy(mint, sol, { priority });
  return r.ok ? r.data : null;
}

/** What selling `tokens` returns right now, as an effective price per token, or why not. */
export async function jupSell(mint: string, tokens: number, priority: Priority = "high"): Promise<JupResult<number>> {
  if (tokens <= 0) return { ok: false, reason: "error" };
  const r = await jupGet<{ outAmount?: string }>(
    `/swap/v1/quote?inputMint=${mint}&outputMint=${WSOL}&amount=${Math.floor(tokens * 10 ** PUMP_DECIMALS)}&slippageBps=1500`,
    { priority },
  );
  if (!r.ok) return r;
  const sol = Number(r.data.outAmount ?? 0) / 1e9;
  return sol > 0 ? { ok: true, data: sol / tokens } : { ok: false, reason: "no-route" };
}

/** Effective sell price for `tokens` (null if it can't be quoted). Exits and open positions: high priority. */
export async function jupSellPrice(mint: string, tokens: number, priority: Priority = "high"): Promise<number | null> {
  const r = await jupSell(mint, tokens, priority);
  return r.ok ? r.data : null;
}

/**
 * Sellability check: quote a buy of `sol`, then a sell of exactly those tokens. A coin you can buy but
 * not sell (honeypot), or that loses a lot on the round trip, shows up here. Returns null when it
 * couldn't be checked (e.g. rate limited): that is "unknown", never "unsellable".
 */
export async function roundTrip(mint: string, sol: number): Promise<{ sellable: boolean; lossPct: number } | null> {
  const b = await jupBuy(mint, sol, { retryNoRoute: 2 });
  if (!b.ok) return null;
  let sell = await jupSell(mint, b.data.tokens, "low");
  // A missing sell route on a brand-new coin is often just the aggregator catching up: ask twice more.
  for (let i = 0; !sell.ok && sell.reason === "no-route" && i < 2; i++) {
    await sleep(1500);
    sell = await jupSell(mint, b.data.tokens, "low");
  }
  if (!sell.ok) return sell.reason === "no-route" ? { sellable: false, lossPct: 100 } : null;
  return { sellable: true, lossPct: (1 - (sell.data * b.data.tokens) / sol) * 100 };
}

export const roundTripReason = (rt: { sellable: boolean; lossPct: number } | null) =>
  !rt ? null : !rt.sellable ? "can't sell (no sell route)" : `round trip loses ${rt.lossPct.toFixed(0)}%`;

/** The coin's PumpSwap pair on DexScreener (pool address, liquidity, 5-minute flow). */
export async function pumpSwapPair(mint: string): Promise<DexPair | null> {
  const pairs = await getJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
  return pairs?.find((p) => p.dexId === "pumpswap" && p.quoteToken.address === WSOL) ?? null;
}

/* ---------------- Candles (GeckoTerminal, free tier: minute and up) ---------------- */

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";

/** [unix seconds, open, high, low, close, volume in SOL], ascending; prices in SOL per token. */
export type Candle = [number, number, number, number, number, number];
export const CANDLE_TFS = { "1m": ["minute", 1], "5m": ["minute", 5], "15m": ["minute", 15], "1h": ["hour", 1], "4h": ["hour", 4], "1d": ["day", 1] } as const;
export type CandleTf = keyof typeof CANDLE_TFS;

type GtPool = { attributes: { address: string; pool_created_at: string | null }; relationships: { dex: { data: { id: string } } } };

/**
 * The coin's pool that was trading at `at`: the newest one created by then (bonding curve before
 * migration, PumpSwap after). Falls back to GeckoTerminal's top pool.
 */
export async function candlePool(mint: string, at: number): Promise<{ address: string; dex: string } | null> {
  const j = await getJson<{ data: GtPool[] }>(`${GT}/tokens/${mint}/pools?page=1`);
  const pools = j?.data ?? [];
  const live = pools
    .filter((p) => p.attributes.pool_created_at && Date.parse(p.attributes.pool_created_at) <= at + 60_000)
    .sort((a, b) => Date.parse(b.attributes.pool_created_at!) - Date.parse(a.attributes.pool_created_at!));
  const p = live[0] ?? pools[0];
  return p ? { address: p.attributes.address, dex: p.relationships.dex.data.id } : null;
}

/** Up to `limit` candles ending at `before` (unix seconds), priced in SOL; null if the request failed. */
export async function candles(pool: string, tf: CandleTf, before: number, limit = 300): Promise<Candle[] | null> {
  const [unit, agg] = CANDLE_TFS[tf];
  const j = await getJson<{ data: { attributes: { ohlcv_list: Candle[] } } }>(
    `${GT}/pools/${pool}/ohlcv/${unit}?aggregate=${agg}&before_timestamp=${before}&limit=${limit}&currency=token`,
  );
  if (!j) return null;
  // Ascending with unique times (the API can repeat the latest bucket).
  const byTime = new Map((j.data?.attributes.ohlcv_list ?? []).map((c) => [c[0], c] as const));
  return [...byTime.values()].sort((a, b) => a[0] - b[0]);
}

/* ---------------- Winner sources for discovery ---------------- */

export type WinnerCandidate = {
  mint: string;
  symbol?: string;
  name?: string;
  mcapUsd: number;
  createdAt?: number;
  creator?: string;
};

/** Trending/boosted Solana tokens from DexScreener that were launched on pump.fun. */
export async function dexscreenerCandidates(): Promise<string[]> {
  const urls = [
    "https://api.dexscreener.com/token-boosts/top/v1",
    "https://api.dexscreener.com/token-boosts/latest/v1",
    "https://api.dexscreener.com/token-profiles/latest/v1",
  ];
  const mints = new Set<string>();
  for (const u of urls) {
    const j = await getJson<{ chainId: string; tokenAddress: string }[]>(u);
    for (const t of j ?? []) {
      if (t.chainId === "solana" && t.tokenAddress?.endsWith("pump")) mints.add(t.tokenAddress);
    }
  }
  return [...mints];
}

/** pump.fun's own (unofficial) API — top coins by market cap. May change without notice. */
export async function pumpfunCandidates(): Promise<WinnerCandidate[]> {
  type Coin = {
    mint: string;
    symbol: string;
    name: string;
    creator: string;
    created_timestamp: number;
    usd_market_cap: number;
  };
  const out: WinnerCandidate[] = [];
  for (const sort of ["market_cap", "last_trade_timestamp"]) {
    const j = await getJson<Coin[]>(
      `https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=${sort}&order=DESC&includeNsfw=false`,
    );
    for (const c of j ?? []) {
      out.push({
        mint: c.mint,
        symbol: c.symbol,
        name: c.name,
        creator: c.creator,
        createdAt: c.created_timestamp,
        mcapUsd: c.usd_market_cap ?? 0,
      });
    }
  }
  return out;
}
