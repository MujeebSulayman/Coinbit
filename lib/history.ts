/**
 * Full-history wallet vetting. Being early on a few winners says nothing about the hundreds of
 * losers a wallet may also buy, so before a wallet is watched we sample its recent trades and
 * compute per-coin PnL across everything it touched. Coins still held are marked to market.
 */
import { PublicKey } from "@solana/web3.js";
import { config } from "./config";
import { quotes } from "./market";
import { conn, getParsedTxs, IGNORED_MINTS, solDelta, tokenDeltas, withRetry } from "./solana";

export type WalletHistory = {
  tokens: number; // distinct coins bought in the sample
  wins: number;
  winRate: number;
  pnlSol: number; // realized + mark-to-market, in SOL
  tokensPerHour: number;
  buySizeCv: number; // stddev / mean of buy sizes; ~0 means a bot with a fixed size
  buys: number;
};

export async function walletHistory(address: string): Promise<WalletHistory> {
  const sigs = await withRetry(() =>
    conn().getSignaturesForAddress(new PublicKey(address), { limit: config.histTxSample }),
  );
  const ok = sigs.filter((s) => !s.err).map((s) => s.signature);
  const txs = (await getParsedTxs(ok)).filter((t): t is NonNullable<typeof t> => !!t);

  type Book = { spent: number; received: number; bought: number; sold: number };
  const books = new Map<string, Book>();
  const buySizes: number[] = [];
  const times: number[] = [];

  for (const tx of txs) {
    const mine = tokenDeltas(tx).filter((d) => d.owner === address && !IGNORED_MINTS.has(d.mint));
    if (mine.length !== 1) continue; // skip multi-token txs: can't attribute SOL cleanly
    const d = mine[0];
    const sol = solDelta(tx, address);
    const b = books.get(d.mint) ?? { spent: 0, received: 0, bought: 0, sold: 0 };
    if (d.delta > 0 && sol < 0) {
      b.spent += -sol;
      b.bought += d.delta;
      buySizes.push(-sol);
    } else if (d.delta < 0 && sol > 0) {
      b.received += sol;
      b.sold += -d.delta;
    } else continue;
    books.set(d.mint, b);
    if (tx.blockTime) times.push(tx.blockTime);
  }

  // Only coins whose buy is inside the sample can be judged (otherwise we'd see sells without cost).
  const judged = [...books.entries()].filter(([, b]) => b.bought > 0);
  const held = judged.filter(([, b]) => b.bought - b.sold > b.bought * 0.01).map(([m]) => m);
  const prices = held.length ? await quotes(held).catch(() => new Map()) : new Map();

  let wins = 0;
  let pnl = 0;
  for (const [mint, b] of judged) {
    const left = Math.max(0, b.bought - b.sold);
    const value = left * (prices.get(mint)?.priceSol ?? 0);
    const p = b.received + value - b.spent;
    pnl += p;
    if (p > 0) wins++;
  }

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
  };
}

/** Returns an exclusion reason, or null if the wallet's history is good enough to watch. */
export function historyVerdict(h: WalletHistory): string | null {
  if (h.tokensPerHour > config.histMaxTokensPerHour) return `bot: trades ${h.tokensPerHour.toFixed(0)} coins/hour`;
  if (h.buys >= 10 && h.buySizeCv < 0.05) return "bot: identical buy sizes";
  if (h.tokens < config.histMinTokens) return null; // too little data to judge — don't punish, don't trust either
  if (h.winRate < config.histMinWinRate) return `history: ${(h.winRate * 100).toFixed(0)}% win rate over ${h.tokens} coins`;
  if (h.pnlSol < config.histMinPnlSol) return `history: ${h.pnlSol.toFixed(2)} SOL PnL over ${h.tokens} coins`;
  return null;
}
