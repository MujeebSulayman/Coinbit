const WSOL = "So11111111111111111111111111111111111111112";

/** SOL/USD for the dashboard, cached ~60s by Next's fetch cache. Kept separate from lib/market (which pulls in @solana/web3.js). Null if unavailable. */
export async function solUsdPrice(): Promise<number | null> {
  const get = async <T,>(url: string): Promise<T | null> => {
    try {
      const res = await fetch(url, { next: { revalidate: 60 }, signal: AbortSignal.timeout(4000) });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  };
  const jup = await get<Record<string, { usdPrice?: number }>>(`https://lite-api.jup.ag/price/v3?ids=${WSOL}`);
  const v = jup?.[WSOL]?.usdPrice;
  if (v && v > 0) return v;
  const cg = await get<{ solana?: { usd?: number } }>("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
  return cg?.solana?.usd && cg.solana.usd > 0 ? cg.solana.usd : null;
}
