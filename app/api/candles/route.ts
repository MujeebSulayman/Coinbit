import { NextResponse, type NextRequest } from "next/server";
import { CANDLE_TFS, candlePool, candles, type CandleTf } from "@/lib/market";

export const dynamic = "force-dynamic";

const TF_SEC: Record<CandleTf, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const LIMIT = 300;
const TTL = 30_000;
// GeckoTerminal's free tier allows ~30 calls/min, so share results between viewers and refreshes.
const cache = new Map<string, { at: number; body: unknown }>();
// Which pool a trade happened on doesn't change; remember it so a view costs one call, not two.
const pools = new Map<string, { address: string; dex: string }>();

/**
 * Market candles for a trade: ?mint=&from=<ms entry>&to=<ms exit, or now>&tf=1m.
 * The window ends ~100 bars after the exit so the trade sits about two thirds of the way across.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const mint = q.get("mint") ?? "";
  const from = Number(q.get("from"));
  const to = Number(q.get("to")) || Date.now();
  const tf = (q.get("tf") ?? "1m") as CandleTf;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || !from || !(tf in CANDLE_TFS))
    return NextResponse.json({ error: "bad request" }, { status: 400 });

  const before = Math.min(Math.floor(Date.now() / 1000), Math.floor(to / 1000) + 100 * TF_SEC[tf]);
  const key = `${mint}:${from}:${tf}:${Math.floor(before / 30)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return NextResponse.json(hit.body);

  const poolKey = `${mint}:${from}`;
  const pool = pools.get(poolKey) ?? (await candlePool(mint, from));
  if (!pool) return NextResponse.json({ error: "market data unavailable" }, { status: 503 });
  if (pools.size > 500) pools.clear();
  pools.set(poolKey, pool);

  const list = await candles(pool.address, tf, before, LIMIT);
  if (!list) return NextResponse.json({ error: "market data unavailable" }, { status: 503 });
  const body = { pool: pool.address, dex: pool.dex, candles: list };
  if (cache.size > 200) cache.clear();
  cache.set(key, { at: Date.now(), body });
  return NextResponse.json(body);
}
