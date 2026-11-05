/**
 * Full-history wallet vetting. Being early on a few winners says nothing about the hundreds of
 * losers a wallet may also buy, so before a wallet is watched we sample its recent trades and
 * compute per-coin PnL across everything it touched. Coins still held are marked to market.
 */
import { PublicKey } from "@solana/web3.js";
import { config } from "./config";
import { quotes } from "./market";
import { conn, getBondingCurves, getParsedTxs, IGNORED_MINTS, solDelta, tokenDeltas, withRetry } from "./solana";

export type WalletHistory = {
  tokens: number; // distinct coins bought in the sample
  wins: number;
  winRate: number;
  pnlSol: number; // realized + mark-to-market, in SOL
  tokensPerHour: number;
  buySizeCv: number; // stddev / mean of buy sizes; ~0 means a bot with a fixed size
  buys: number;
  // Followability and profile (null when the sample can't tell)
  medianHoldSec: number | null;
  quickSellPct: number | null;
  topCreatorPct: number | null;
  bestCoinPct: number | null;
  lastTradeAt: Date | null;
};

const QUICK_SELL_SEC = 30;

export async function walletHistory(address: string): Promise<WalletHistory> {
  const sigs = await withRetry(() =>
    conn().getSignaturesForAddress(new PublicKey(address), { limit: config.histTxSample }),
  );
  const ok = sigs.filter((s) => !s.err).map((s) => s.signature);
  const txs = (await getParsedTxs(ok)).filter((t): t is NonNullable<typeof t> => !!t);

  type Book = { spent: number; received: number; bought: number; sold: number; firstBuy: number; firstSell: number };
  const books = new Map<string, Book>();
  const buySizes: number[] = [];
  const times: number[] = [];

  for (const tx of txs) {
    const mine = tokenDeltas(tx).filter((d) => d.owner === address && !IGNORED_MINTS.has(d.mint));
    if (mine.length !== 1) continue; // skip multi-token txs: can't attribute SOL cleanly
    const d = mine[0];
    const sol = solDelta(tx, address);
    const b = books.get(d.mint) ?? { spent: 0, received: 0, bought: 0, sold: 0, firstBuy: Infinity, firstSell: Infinity };
    const t = tx.blockTime ?? 0;
    if (d.delta > 0 && sol < 0) {
      b.spent += -sol;
      b.bought += d.delta;
      buySizes.push(-sol);
      if (t) b.firstBuy = Math.min(b.firstBuy, t);
    } else if (d.delta < 0 && sol > 0) {
      b.received += sol;
      b.sold += -d.delta;
      if (t) b.firstSell = Math.min(b.firstSell, t);
    } else continue; // tokens received by transfer (no SOL paid) are not trading
    books.set(d.mint, b);
    if (tx.blockTime) times.push(tx.blockTime);
  }

  // Only coins whose buy is inside the sample can be judged (otherwise we'd see sells without cost).
  const judged = [...books.entries()].filter(([, b]) => b.bought > 0);
  const held = judged.filter(([, b]) => b.bought - b.sold > b.bought * 0.01).map(([m]) => m);
  const prices = held.length ? await quotes(held).catch(() => new Map()) : new Map();

  let wins = 0;
  let pnl = 0;
  const coinPnls: number[] = [];
  for (const [mint, b] of judged) {
    const left = Math.max(0, b.bought - b.sold);
    const value = left * (prices.get(mint)?.priceSol ?? 0);
    // Selling more than was bought means the rest arrived by transfer: count only the bought share.
    // (51% of big pump.fun "wallet wins" were sales of transferred tokens; TokenPost, Oct 2026.)
    const received = b.sold > b.bought ? b.received * (b.bought / b.sold) : b.received;
    const p = received + value - b.spent;
    pnl += p;
    coinPnls.push(p);
    if (p > 0) wins++;
  }

  // Hold time: first buy → first sell, per coin that was both bought and sold in the sample.
  const holds = judged.filter(([, b]) => b.firstSell < Infinity && b.firstBuy < Infinity && b.firstSell >= b.firstBuy).map(([, b]) => b.firstSell - b.firstBuy);
  holds.sort((a, c) => a - c);
  // Creator breadth: copy generalists, not insiders (D3AD-E: <20-creator wallets lost 3,562 SOL in aggregate).
  const curves = judged.length ? await getBondingCurves(judged.map(([m]) => m)).catch(() => new Map()) : new Map();
  const perCreator = new Map<string, number>();
  for (const [m] of judged) {
    const c = curves.get(m)?.creator;
    if (c) perCreator.set(c, (perCreator.get(c) ?? 0) + 1);
  }
  const withCreator = [...perCreator.values()].reduce((x, y) => x + y, 0);
  const winsTotal = coinPnls.filter((x) => x > 0).reduce((x, y) => x + y, 0);

  const spanH = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 3600 : 0;
  const mean = buySizes.reduce((s, x) => s + x, 0) / Math.max(1, buySizes.length);
  const sd = Math.sqrt(buySizes.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, buySizes.length));

  return {
    tokens: judged.length,
    wins,
    winRate: judged.length ? wins / judged.length : 0,
    pnlSol: pnl,
    tokensPerHour: spanH > 0 ? books.size / spanH : 0,
    buySizeCv: mean > 0 ? sd / mean : 0,
    buys: buySizes.length,
    medianHoldSec: holds.length >= 3 ? holds[Math.floor(holds.length / 2)] : null,
    quickSellPct: holds.length >= 3 ? (holds.filter((h) => h <= QUICK_SELL_SEC).length / holds.length) * 100 : null,
    topCreatorPct: withCreator >= 5 ? (Math.max(...perCreator.values()) / withCreator) * 100 : null,
    bestCoinPct: winsTotal > 0 ? (Math.max(...coinPnls) / winsTotal) * 100 : null,
    lastTradeAt: times.length ? new Date(Math.max(...times) * 1000) : null,
  };
}

/** Returns an exclusion reason, or null if the wallet's history is good enough to watch. */
export function historyVerdict(h: WalletHistory): string | null {
  if (h.tokensPerHour > config.histMaxTokensPerHour) return `bot: trades ${h.tokensPerHour.toFixed(0)} coins/hour`;
  if (h.buys >= 10 && h.buySizeCv < 0.05) return "bot: identical buy sizes";
  if (h.tokens < config.histMinTokens) return null; // too little data to judge: not excluded, but not watched either
  // Can a copier act in time? (Blizz: median hold <20s or 30%+ sold within 30s = can't follow; a pump.fun
  // copy study found copies at a 2s+ delay lose across all sizes.)
  if (h.medianHoldSec !== null && h.medianHoldSec < config.histMinMedianHoldSec) return `can't follow: median hold ${Math.round(h.medianHoldSec)}s`;
  if (h.quickSellPct !== null && h.quickSellPct > config.histMaxQuickSellPct)
    return `can't follow: sells within ${QUICK_SELL_SEC}s on ${h.quickSellPct.toFixed(0)}% of coins`;
  if (h.topCreatorPct !== null && h.topCreatorPct > config.histMaxTopCreatorPct) return `insider: ${h.topCreatorPct.toFixed(0)}% of coins from one creator`;
  if (h.winRate < config.histMinWinRate) return `history: ${(h.winRate * 100).toFixed(0)}% win rate over ${h.tokens} coins`;
  if (h.pnlSol < config.histMinPnlSol) return `history: ${h.pnlSol.toFixed(2)} SOL PnL over ${h.tokens} coins`;
  if (h.bestCoinPct !== null && h.bestCoinPct > config.histMaxBestCoinPct) return `one-hit: ${h.bestCoinPct.toFixed(0)}% of profit from one coin`;
  return null;
}

/** Judged = enough coins in the sample to trust the verdict. Only judged wallets are watched. */
export const historyJudged = (tokens: number | null | undefined) => (tokens ?? 0) >= config.histMinTokens;
