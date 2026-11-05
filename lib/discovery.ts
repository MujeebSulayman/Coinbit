/**
 * Discovery engine — finds smart wallets automatically.
 *
 * 1. Collect coins that "won" (big market cap) from DexScreener, pump.fun, and coins
 *    our own watched wallets bought (self-learning loop).
 * 2. For each winner, walk the bonding curve back to launch and record the first N buyers.
 * 3. Score every wallet by how often and how early it shows up on winners.
 * 4. Filter out launch-block snipers/bundles, dev insiders and high-frequency bots.
 * 5. Vet each candidate's full recent trading history (win rate / PnL across all coins).
 * 6. Promote the top vetted wallets (traders + launchers) to the watchlist; demote the rest.
 */
import { db, log, setKv } from "./db";
import { config } from "./config";
import {
  bondingCurvePda,
  conn,
  feePayer,
  getParsedTxs,
  isPumpCreate,
  oldestSignatures,
  solDelta,
  tokenDeltas,
  withRetry,
} from "./solana";
import { dexscreenerCandidates, pumpfunCandidates, quotes, type WinnerCandidate } from "./market";
import { PublicKey } from "@solana/web3.js";
import { notify } from "./telegram";
import { historyJudged, historyVerdict, walletHistory } from "./history";

const MAX_TOKENS_PER_RUN = Number(process.env.DISCOVERY_MAX_TOKENS ?? 40);
const STICKY_EXCLUDES = ["hft", "manual", "bot"];

async function collectWinners(): Promise<WinnerCandidate[]> {
  const [dex, pump, learned, graduates] = await Promise.all([
    dexscreenerCandidates().catch(() => [] as string[]),
    pumpfunCandidates().catch(() => [] as WinnerCandidate[]),
    db.walletEvent
      .findMany({
        where: { side: "BUY", ts: { gte: new Date(Date.now() - 7 * 864e5) } },
        distinct: ["mint"],
        select: { mint: true },
        take: 300,
      })
      .then((r) => r.map((x) => x.mint)),
    // Coins the migration feed saw graduate in the last 3 days: a steady stream of fresh candidates.
    db.token.findMany({
      where: { isWinner: false, createdAt: { gte: new Date(Date.now() - 3 * 864e5) } },
      select: { mint: true, peakMcapUsd: true },
      take: 1000,
    }),
  ]);

  const byMint = new Map<string, WinnerCandidate>();
  for (const c of pump) byMint.set(c.mint, c);
  for (const m of [...dex, ...learned]) if (!byMint.has(m)) byMint.set(m, { mint: m, mcapUsd: 0 });
  // Graduates count by their PEAK market cap: many spike and fade, and the early buyers of the spike are who we want.
  for (const g of graduates) if (!byMint.has(g.mint)) byMint.set(g.mint, { mint: g.mint, mcapUsd: g.peakMcapUsd });

  // Refresh market caps for everything.
  const q = await quotes([...byMint.keys()]);
  for (const [m, c] of byMint) {
    const qq = q.get(m);
    if (qq) {
      c.mcapUsd = Math.max(c.mcapUsd, qq.mcapUsd);
      c.symbol ??= qq.symbol;
      c.name ??= qq.name;
    }
  }

  // Keep peak market caps of tracked graduates current, so a spike between runs isn't missed.
  const gradSet = new Set(graduates.map((g) => g.mint));
  for (const [m, c] of byMint) {
    if (gradSet.has(m) && c.mcapUsd > 0) {
      await db.token.updateMany({ where: { mint: m, peakMcapUsd: { lt: c.mcapUsd } }, data: { peakMcapUsd: c.mcapUsd, mcapUsd: c.mcapUsd, symbol: c.symbol } });
    }
  }

  const winners = [...byMint.values()].filter(
    (c) => c.mint.endsWith("pump") && c.mcapUsd >= config.winnerMinPeakMcapUsd,
  );

  // Track peak mcap for all known tokens.
  for (const w of winners) {
    await db.token.upsert({
      where: { mint: w.mint },
      create: { mint: w.mint, symbol: w.symbol, name: w.name, creator: w.creator, mcapUsd: w.mcapUsd, peakMcapUsd: w.mcapUsd, isWinner: true },
      update: { mcapUsd: w.mcapUsd, isWinner: true, symbol: w.symbol ?? undefined },
    });
    await db.token.updateMany({ where: { mint: w.mint, peakMcapUsd: { lt: w.mcapUsd } }, data: { peakMcapUsd: w.mcapUsd } });
  }
  return winners.sort((a, b) => b.mcapUsd - a.mcapUsd);
}

/** Walks a winner back to launch and records its earliest buyers. */
export async function studyToken(mint: string): Promise<number> {
  const curve = bondingCurvePda(mint);
  const curveAddr = curve.toBase58();
  const { sigs, reachedStart } = await oldestSignatures(curve);
  if (!reachedStart || sigs.length === 0) {
    await db.token.update({ where: { mint }, data: { studiedAt: new Date() } });
    await log("discovery", `skip ${mint}: too much history to reach launch`);
    return 0;
  }

  const N = config.earlyBuyerCount;
  const ok = sigs.filter((s) => !s.err).slice(0, N * 3).map((s) => s.signature);
  const txs = (await getParsedTxs(ok)).filter((t): t is NonNullable<typeof t> => !!t);
  if (txs.length === 0) return 0;

  const createTx = txs.find((t) => isPumpCreate(t.meta?.logMessages)) ?? txs[0];
  const creator = feePayer(createTx);
  const launchTime = createTx.blockTime ?? 0;
  const createSlot = createTx.slot;

  const seen = new Set<string>([creator, curveAddr]);
  const entries: { wallet: string; rank: number; minutesIn: number; solAmount: number; slot: number }[] = [];
  for (const tx of txs) {
    if (entries.length >= N) break;
    for (const d of tokenDeltas(tx)) {
      if (d.mint !== mint || d.delta <= 0 || seen.has(d.owner)) continue;
      seen.add(d.owner);
      entries.push({
        wallet: d.owner,
        rank: entries.length + 1,
        minutesIn: launchTime && tx.blockTime ? (tx.blockTime - launchTime) / 60 : 0,
        solAmount: Math.max(0, -solDelta(tx, d.owner)),
        slot: tx.slot,
      });
    }
  }

  await db.token.update({
    where: { mint },
    data: {
      creator,
      createSlot,
      launchedAt: launchTime ? new Date(launchTime * 1000) : undefined,
      studiedAt: new Date(),
    },
  });
  await db.wallet.createMany({
    data: [creator, ...entries.map((e) => e.wallet)].map((address) => ({ address })),
    skipDuplicates: true,
  });
  await db.earlyEntry.createMany({
    data: entries.map((e) => ({ ...e, mint })),
    skipDuplicates: true,
  });
  return entries.length;
}

/** Recomputes every wallet's score from its early entries + our copy-trade results. */
export async function rescoreWallets() {
  const N = config.earlyBuyerCount;
  const [entries, tokens, wallets] = await Promise.all([
    db.earlyEntry.findMany({ select: { wallet: true, mint: true, rank: true, minutesIn: true, slot: true } }),
    db.token.findMany({ where: { isWinner: true }, select: { mint: true, creator: true, createSlot: true } }),
    db.wallet.findMany(),
  ]);
  const tokenBy = new Map(tokens.map((t) => [t.mint, t]));
  const launchWins = new Map<string, number>();
  for (const t of tokens) if (t.creator) launchWins.set(t.creator, (launchWins.get(t.creator) ?? 0) + 1);

  const byWallet = new Map<string, typeof entries>();
  for (const e of entries) {
    const arr = byWallet.get(e.wallet) ?? [];
    arr.push(e);
    byWallet.set(e.wallet, arr);
  }

  for (const w of wallets) {
    const es = byWallet.get(w.address) ?? [];
    const winners = es.length;
    const earliness = winners ? es.reduce((s, e) => s + (1 - (e.rank - 1) / N), 0) / winners : 0;
    const avgRank = winners ? es.reduce((s, e) => s + e.rank, 0) / winners : 0;
    const avgMin = winners ? es.reduce((s, e) => s + e.minutesIn, 0) / winners : 0;
    const bundleRate = winners
      ? es.filter((e) => tokenBy.get(e.mint)?.createSlot === e.slot).length / winners
      : 0;

    const perCreator = new Map<string, number>();
    for (const e of es) {
      const c = tokenBy.get(e.mint)?.creator;
      if (c) perCreator.set(c, (perCreator.get(c) ?? 0) + 1);
    }
    const [topCreator, topCreatorCount] = [...perCreator.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];

    const lw = launchWins.get(w.address) ?? 0;
    const traderScore =
      winners * 10 + earliness * 15 - (avgMin > 60 ? 5 : 0) + Math.max(-30, Math.min(30, w.copyPnlSol * 10));
    const launcherScore = lw * 15 + Math.max(-30, Math.min(30, w.copyPnlSol * 10));
    const isLauncher = lw >= config.minWinnersForWatch && launcherScore >= traderScore;
    let score = Math.max(traderScore, launcherScore);
    // Full-history quality: reward wallets that are profitable across everything they trade.
    if (w.histTokens != null && w.histTokens >= config.histMinTokens) {
      score += (w.histWinRate ?? 0) * 20 + Math.max(-20, Math.min(20, (w.histPnlSol ?? 0) * 2));
    }
    if (w.lastActivity && Date.now() - w.lastActivity.getTime() > 14 * 864e5) score *= 0.7;

    let excludeReason: string | null = null;
    const sticky = w.excludeReason && STICKY_EXCLUDES.some((p) => w.excludeReason!.startsWith(p));
    if (w.allowed) excludeReason = null; // manually allowed from the dashboard
    else if (sticky) excludeReason = w.excludeReason;
    else if (winners >= 2 && bundleRate >= 0.5) excludeReason = "sniper: buys in the launch block (bundle/dev group)";
    else if (topCreatorCount >= 2 && topCreatorCount / Math.max(1, winners) > 0.6 && !isLauncher)
      excludeReason = `insider: mostly early on coins from launcher ${topCreator.slice(0, 6)}`;
    else if (w.signalHits >= 5 && w.copyPnlSol <= -1) excludeReason = "copies of this wallet lose money";

    await db.wallet.update({
      where: { address: w.address },
      data: {
        kind: isLauncher ? "LAUNCHER" : "TRADER",
        winners,
        tokensSeen: winners,
        avgEntryRank: avgRank,
        avgEntryMin: avgMin,
        launchWinners: lw,
        launches: lw,
        score,
        lastScored: new Date(),
        excludeReason,
        status: excludeReason ? "EXCLUDED" : w.status === "EXCLUDED" ? "CANDIDATE" : w.status,
      },
    });
  }
}

/** True if the wallet looks like a high-frequency trading bot (1000 txs in under 3 hours). */
async function looksLikeHftBot(address: string): Promise<boolean> {
  const sigs = await withRetry(() => conn().getSignaturesForAddress(new PublicKey(address), { limit: 1000 }));
  if (sigs.length < 1000) return false;
  const span = (sigs[0].blockTime ?? 0) - (sigs[sigs.length - 1].blockTime ?? 0);
  return span > 0 && span < 3 * 3600;
}

/** Stored history → exclusion reason (re-evaluated every refresh, so threshold changes apply immediately). */
type StoredHist = {
  histTokens: number | null;
  histWinRate: number | null;
  histPnlSol: number | null;
  histTokensPerHour: number | null;
  histMedianHoldSec: number | null;
  histQuickSellPct: number | null;
  histTopCreatorPct: number | null;
  histBestCoinPct: number | null;
  histLastTradeAt: Date | null;
};
function storedHistoryVerdict(w: StoredHist) {
  if (w.histTokens == null) return null;
  return historyVerdict({
    tokens: w.histTokens,
    wins: 0,
    winRate: w.histWinRate ?? 0,
    pnlSol: w.histPnlSol ?? 0,
    tokensPerHour: w.histTokensPerHour ?? 0,
    buySizeCv: 1, // identical-size bots are excluded stickily at check time
    buys: 0,
    medianHoldSec: w.histMedianHoldSec,
    quickSellPct: w.histQuickSellPct,
    topCreatorPct: w.histTopCreatorPct,
    bestCoinPct: w.histBestCoinPct,
    lastTradeAt: w.histLastTradeAt,
  });
}

/** Hours since the wallet last traded, from the live listener or its history sample (whichever is newer). */
function idleHours(w: { lastActivity: Date | null; histLastTradeAt: Date | null }) {
  const last = Math.max(w.lastActivity?.getTime() ?? 0, w.histLastTradeAt?.getTime() ?? 0);
  return last ? (Date.now() - last) / 3600e3 : Infinity;
}

/**
 * Picks the watchlist from the best-scoring candidates. Only wallets whose full history has been
 * vetted are watched; up to `vetBudget` unvetted (or stale) wallets are vetted per call.
 */
let refreshing = false;
export async function refreshWatchlist(vetBudget = config.histPerRun) {
  if (refreshing) {
    const n = await db.wallet.count({ where: { status: "WATCHING" } });
    return { before: n, after: n, vetted: 0 };
  }
  refreshing = true;
  try {
    return await doRefreshWatchlist(vetBudget);
  } finally {
    refreshing = false;
  }
}

async function doRefreshWatchlist(vetBudget: number) {
  const min = config.minWinnersForWatch;
  const minProven = Math.min(min, config.minWinnersWithHistory);
  const top = await db.wallet.findMany({
    where: { status: { not: "EXCLUDED" }, OR: [{ winners: { gte: minProven } }, { launchWinners: { gte: min } }] },
    orderBy: { score: "desc" },
    take: config.watchlistSize * 2,
  });
  // Currently watched wallets are always re-evaluated, even if their score fell outside the top slice,
  // so a vetted wallet isn't silently dropped just because many unvetted candidates outrank it.
  const watching = await db.wallet.findMany({ where: { status: "WATCHING", address: { notIn: top.map((w) => w.address) } } });
  const eligible = [...top, ...watching].sort((a, b) => b.score - a.score);
  const staleBefore = new Date(Date.now() - config.histRecheckDays * 864e5);

  const picked: string[] = [];
  let vetted = 0;
  for (const w of eligible) {
    if (picked.length >= config.watchlistSize) break;
    if (w.allowed) {
      picked.push(w.address);
      continue;
    }
    if (!w.botChecked) {
      const bot = await looksLikeHftBot(w.address).catch(() => false);
      await db.wallet.update({
        where: { address: w.address },
        data: bot
          ? { botChecked: true, status: "EXCLUDED", excludeReason: "hft: trading bot (1000+ txs in 3h)" }
          : { botChecked: true },
      });
      if (bot) continue;
    }

    let hist = w;
    if (!w.histCheckedAt || w.histCheckedAt < staleBefore) {
      if (vetted >= vetBudget) {
        // Not vetted yet: keep watching if it already was (until its turn comes), never promote unvetted.
        if (w.status === "WATCHING" && w.histCheckedAt) picked.push(w.address);
        continue;
      }
      vetted++;
      try {
        const h = await walletHistory(w.address);
        hist = await db.wallet.update({
          where: { address: w.address },
          data: {
            histTokens: h.tokens,
            histWinRate: h.winRate,
            histPnlSol: h.pnlSol,
            histTokensPerHour: h.tokensPerHour,
            histMedianHoldSec: h.medianHoldSec,
            histQuickSellPct: h.quickSellPct,
            histTopCreatorPct: h.topCreatorPct,
            histBestCoinPct: h.bestCoinPct,
            histLastTradeAt: h.lastTradeAt,
            histCheckedAt: new Date(),
          },
        });
        const verdict = historyVerdict(h);
        if (verdict?.startsWith("bot")) {
          await db.wallet.update({ where: { address: w.address }, data: { status: "EXCLUDED", excludeReason: verdict } });
          continue;
        }
      } catch (e) {
        await log("discovery", `history check ${w.address} failed: ${(e as Error).message}`);
        continue;
      }
    }

    // Only wallets whose history was judged on enough coins are watched (winners alone used to be
    // enough; research guides want a real track record). Launchers are judged on their launches.
    const isLauncher = w.kind === "LAUNCHER" && w.launchWinners >= min;
    if (!isLauncher && !historyJudged(hist.histTokens)) continue;
    // Stopped trading: free the slot for an active candidate (not excluded; it can come back).
    if (idleHours(hist) > config.watchMaxIdleHours) continue;
    const verdict = storedHistoryVerdict(hist);
    if (verdict) {
      await db.wallet.update({ where: { address: w.address }, data: { status: "EXCLUDED", excludeReason: verdict } });
      continue;
    }
    picked.push(w.address);
  }

  const before = await db.wallet.count({ where: { status: "WATCHING" } });
  await db.wallet.updateMany({
    where: { status: "WATCHING", address: { notIn: picked } },
    data: { status: "CANDIDATE" },
  });
  await db.wallet.updateMany({ where: { address: { in: picked } }, data: { status: "WATCHING" } });
  return { before, after: picked.length, vetted };
}

/** Background job: vets more candidates between discovery runs so the watchlist keeps growing. */
export async function vetMore() {
  if (running) return null;
  const r = await refreshWatchlist();
  if (r.vetted) await log("discovery", `vetted ${r.vetted} wallets, watchlist ${r.before} → ${r.after}`);
  return r;
}

let running = false;
export async function runDiscovery() {
  if (running) return;
  running = true;
  const started = Date.now();
  try {
    await log("discovery", "run started");
    const winners = await collectWinners();
    const unstudied = await db.token.findMany({
      where: { isWinner: true, studiedAt: null, mint: { in: winners.map((w) => w.mint) } },
      select: { mint: true },
    });
    let studied = 0;
    let buyers = 0;
    for (const t of unstudied.slice(0, MAX_TOKENS_PER_RUN)) {
      try {
        buyers += await studyToken(t.mint);
        studied++;
      } catch (e) {
        await log("discovery", `study ${t.mint} failed: ${(e as Error).message}`);
      }
    }
    await rescoreWallets();
    const wl = await refreshWatchlist();
    const msg = `winners found ${winners.length}, studied ${studied}, early buyers ${buyers}, watchlist ${wl.before} → ${wl.after}, vetted ${wl.vetted} (${Math.round((Date.now() - started) / 1000)}s)`;
    await log("discovery", msg);
    await setKv("discovery:lastRun", new Date().toISOString());
    await notify(`🔎 <b>Discovery done</b>\n${msg}`);
  } finally {
    running = false;
  }
}
