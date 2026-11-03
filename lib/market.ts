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
  const j = await getJson<Record<string, { usdPrice?: number }>>(
    `https://lite-api.jup.ag/price/v3?ids=${WSOL}`,
  );
  let v = j?.[WSOL]?.usdPrice ?? 0;
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
    if (bc && !bc.complete && bc.priceSol > 0) {
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

const JUP = "https://lite-api.jup.ag/swap/v1";

/** What `sol` buys right now: tokens out and effective price (includes fees and price impact). */
export async function jupBuyQuote(mint: string, sol: number): Promise<{ tokens: number; priceSol: number; impactPct: number } | null> {
  const j = await getJson<{ outAmount?: string; priceImpactPct?: string }>(
    `${JUP}/quote?inputMint=${WSOL}&outputMint=${mint}&amount=${Math.floor(sol * 1e9)}&slippageBps=1500`,
    5000,
  );
  const tokens = Number(j?.outAmount ?? 0) / 10 ** PUMP_DECIMALS;
  if (!tokens) return null;
  return { tokens, priceSol: sol / tokens, impactPct: Number(j?.priceImpactPct ?? 0) * 100 };
}

/** What selling `tokens` returns right now, as an effective price per token. */
export async function jupSellPrice(mint: string, tokens: number): Promise<number | null> {
  if (tokens <= 0) return null;
  const j = await getJson<{ outAmount?: string }>(
    `${JUP}/quote?inputMint=${mint}&outputMint=${WSOL}&amount=${Math.floor(tokens * 10 ** PUMP_DECIMALS)}&slippageBps=1500`,
    5000,
  );
  const sol = Number(j?.outAmount ?? 0) / 1e9;
  return sol > 0 ? sol / tokens : null;
}

/** Sellability check: quote a buy of `sol`, then a sell of exactly those tokens. A coin you can buy but
 *  not sell (honeypot), or that loses a lot on the round trip, shows up here. null = couldn't quote a buy. */
export async function roundTrip(mint: string, sol: number): Promise<{ sellable: boolean; lossPct: number } | null> {
  const b = await jupBuyQuote(mint, sol);
  if (!b) return null;
  let sellPrice = await jupSellPrice(mint, b.tokens);
  // A missing sell route on a brand-new coin is often just the aggregator catching up: ask twice more.
  for (let i = 0; !sellPrice && i < 2; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    sellPrice = await jupSellPrice(mint, b.tokens);
  }
  if (!sellPrice) return { sellable: false, lossPct: 100 };
  return { sellable: true, lossPct: (1 - (sellPrice * b.tokens) / sol) * 100 };
}

export const roundTripReason = (rt: { sellable: boolean; lossPct: number } | null) =>
  !rt ? null : !rt.sellable ? "can't sell (no sell route)" : `round trip loses ${rt.lossPct.toFixed(0)}%`;

/** The coin's PumpSwap pair on DexScreener (pool address, liquidity, 5-minute flow). */
export async function pumpSwapPair(mint: string): Promise<DexPair | null> {
  const pairs = await getJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
  return pairs?.find((p) => p.dexId === "pumpswap" && p.quoteToken.address === WSOL) ?? null;
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
