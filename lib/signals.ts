/** Signal engine — decides whether a tracked buy (or launch) is worth copying. */
import { PublicKey, type ConfirmedSignatureInfo, type ParsedAccountData } from "@solana/web3.js";
import { config } from "./config";
import { db, log } from "./db";
import { jupBuyQuote, quotes, roundTrip, roundTripReason, solUsd, type Quote } from "./market";
import { openPosition, riskBlock } from "./positions";
import { independentGroups } from "./linked";
import { tokenNames } from "./tokenmeta";
import { bondingCurvePda, conn, feePayer, getParsedTxs, PUMP_TOTAL_SUPPLY, tokenDeltas, withRetry } from "./solana";
import { strategyMode } from "./modes";
import { notify, short } from "./telegram";

/** Age in minutes, plus the curve's full history (oldest first) when it's short enough to fetch in one call.
 *  unknown = the history lookup failed, so "no age" must not be read as "old" (or as "long run"). */
export async function tokenAge(
  mint: string,
  pairCreatedAt?: number,
): Promise<{ ageMin: number | null; sigs: ConfirmedSignatureInfo[] | null; unknown: boolean }> {
  const sigs = await withRetry(() => conn().getSignaturesForAddress(bondingCurvePda(mint), { limit: 1000 }), 5).catch(() => null);
  const full = sigs && sigs.length > 0 && sigs.length < 1000 ? [...sigs].reverse() : null;
  const t = await db.token.findUnique({ where: { mint }, select: { launchedAt: true } });
  if (t?.launchedAt) return { ageMin: (Date.now() - t.launchedAt.getTime()) / 60_000, sigs: full, unknown: false };
  if (full?.[0]?.blockTime) return { ageMin: (Date.now() / 1000 - full[0].blockTime) / 60, sigs: full, unknown: false };
  if (pairCreatedAt) return { ageMin: (Date.now() - pairCreatedAt) / 60_000, sigs: full, unknown: false };
  // 1000+ curve txs → definitely not brand new; no answer at all → we simply don't know.
  return { ageMin: null, sigs: full, unknown: !sigs || sigs.length === 0 };
}

/** Mint-level risks: mint/freeze authority still set (deployer can print tokens or freeze our account),
 *  or a supply above the standard 1B (pump.fun "mayhem mode" mints an extra 1B to a trading agent,
 *  which breaks market-cap and holder math). */
export async function mintRisk(mint: string): Promise<string | null> {
  const info = await withRetry(() => conn().getParsedAccountInfo(new PublicKey(mint))).catch(() => null);
  const parsed = (info?.value?.data as ParsedAccountData | undefined)?.parsed?.info;
  if (!parsed) return null;
  if (parsed.freezeAuthority) return "freeze authority active";
  if (parsed.mintAuthority) return "mint authority active";
  const supply = Number(parsed.supply) / 10 ** (parsed.decimals ?? 6);
  if (supply > PUMP_TOTAL_SUPPLY * 1.01) return `non-standard supply ${(supply / 1e9).toFixed(1)}B (mayhem mode)`;
  return null;
}

/** % of supply still held by the coin's creator. */
export async function devHoldPct(mint: string, creator: string | null | undefined): Promise<number | null> {
  if (!creator) return null;
  try {
    const res = await withRetry(() => conn().getParsedTokenAccountsByOwner(new PublicKey(creator), { mint: new PublicKey(mint) }));
    const held = res.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
    return (held / PUMP_TOTAL_SUPPLY) * 100;
  } catch {
    return null;
  }
}

/** Launch slot: % of supply bought by wallets other than the creator (bundles / snipers), and the
 *  creator's own launch buy (to spot an early dev dump). */
async function launchSlot(mint: string, sigs: ConfirmedSignatureInfo[] | null): Promise<{ snipePct: number; creatorPct: number } | null> {
  if (!sigs?.length) return null;
  const slot = sigs[0].slot;
  const inSlot = sigs.filter((s) => s.slot === slot && !s.err).slice(0, 10).map((s) => s.signature);
  const txs = (await getParsedTxs(inSlot)).filter((t): t is NonNullable<typeof t> => !!t);
  if (!txs.length) return null;
  const creator = feePayer(txs[0]);
  const curve = bondingCurvePda(mint).toBase58();
  let bought = 0;
  let creatorBought = 0;
  for (const tx of txs) {
    for (const d of tokenDeltas(tx)) {
      if (d.mint !== mint || d.delta <= 0 || d.owner === curve) continue;
      if (d.owner === creator) creatorBought += d.delta;
      else bought += d.delta;
    }
  }
  return { snipePct: (bought / PUMP_TOTAL_SUPPLY) * 100, creatorPct: (creatorBought / PUMP_TOTAL_SUPPLY) * 100 };
}

/** Estimated price impact of our buy, in %. */
async function priceImpactPct(q: Quote): Promise<number | null> {
  if (q.curve) return (config.positionSizeSol / q.curve.vSol) * 100;
  if (q.liquidityUsd) return ((config.positionSizeSol * (await solUsd())) / (q.liquidityUsd / 2)) * 100;
  return null;
}

export type HolderStats = {
  top10Pct: number;
  /** Largest group of top holders with near-identical bags (≥2% each, within 3% of each other):
   *  the fingerprint of one entity buying through many wallets (bundled launch / manufactured graduation). */
  identical: number;
  identicalPct: number; // the bag size of that group, % of supply
};

/** Top-holder concentration, ignoring the bonding curve and any pool accounts passed in. */
export async function holderStats(mint: string, excludeOwners: string[] = []): Promise<HolderStats | null> {
  try {
    const largest = await withRetry(() => conn().getTokenLargestAccounts(new PublicKey(mint)));
    const accts = largest.value.slice(0, 15);
    const infos = await conn().getMultipleParsedAccounts(accts.map((a) => a.address));
    const skip = new Set([bondingCurvePda(mint).toBase58(), ...excludeOwners]);
    const bags: number[] = [];
    infos.value.forEach((info, i) => {
      const owner = (info?.data as ParsedAccountData | undefined)?.parsed?.info?.owner as string | undefined;
      if ((owner && skip.has(owner)) || bags.length >= 10) return;
      bags.push(((accts[i].uiAmount ?? 0) / PUMP_TOTAL_SUPPLY) * 100);
    });
    let identical = 0;
    let identicalPct = 0;
    for (const b of bags) {
      if (b < 2) continue;
      const group = bags.filter((x) => Math.abs(x - b) <= b * 0.03).length;
      if (group > identical) [identical, identicalPct] = [group, b];
    }
    return { top10Pct: bags.reduce((s, x) => s + x, 0), identical, identicalPct };
  } catch {
    return null;
  }
}

export async function top10HolderPct(mint: string, excludeOwners: string[] = []): Promise<number | null> {
  return (await holderStats(mint, excludeOwners))?.top10Pct ?? null;
}

export const bundledReason = (h: HolderStats) => `bundled: ${h.identical} wallets hold ${h.identicalPct.toFixed(1)}% each`;

/** Runs every pre-buy check on a coin. skip = first failed check, or null if it's buyable. */
export async function checkToken(mint: string) {
  const q = (await quotes([mint])).get(mint);
  const tok = await db.token.findUnique({ where: { mint }, select: { creator: true } });
  const [{ ageMin, sigs, unknown: ageUnknown }, holders, authority, devPct] = await Promise.all([
    tokenAge(mint, q?.pairCreatedAt),
    holderStats(mint),
    mintRisk(mint),
    devHoldPct(mint, q?.curve?.creator ?? tok?.creator),
  ]);
  const launch = await launchSlot(mint, sigs).catch(() => null);
  const snipePct = launch?.snipePct ?? null;
  // Creator sold most of their launch buy already (early dev selling raises the odds the coin dies).
  const devSoldPct = launch && launch.creatorPct > 1 && devPct !== null ? Math.max(0, (1 - devPct / launch.creatorPct) * 100) : null;
  const rt = q ? await roundTrip(mint, config.positionSizeSol).catch(() => null) : null;
  const impact = q ? await priceImpactPct(q) : null;
  const curvePct = q?.curve?.progressPct ?? null;
  // DexScreener only names coins once they trade on a DEX; curve coins get their name from the chain.
  const symbol = q?.symbol ?? (await tokenNames([mint]).catch(() => new Map())).get(mint)?.symbol ?? null;
  const top10 = holders?.top10Pct ?? null;

  let skip: string | null = null;
  // Non-SOL first: such pools often have no SOL price at all, which used to read as "no price".
  if (q && (q.nonStandard || q.nonSolPool) && !config.copyAllowNonSol)
    skip = q.nonSolPool ? `pool quoted in ${q.nonSolPool}, not SOL` : "non-standard curve (not SOL-quoted)";
  else if (!q || q.priceSol <= 0) skip = "no price";
  else if (q.mcapUsd > config.maxEntryMcapUsd) skip = `mcap $${Math.round(q.mcapUsd).toLocaleString()} too high`;
  else if (q.mcapUsd < config.copyMinMcapUsd) skip = `mcap $${Math.round(q.mcapUsd).toLocaleString()} below the $${config.copyMinMcapUsd.toLocaleString()} minimum`;
  else if (ageUnknown) skip = "age unknown (history lookup failed)";
  else if (ageMin === null || ageMin > config.maxTokenAgeMin) skip = `too old (${ageMin === null ? "1000+ txs" : `${Math.round(ageMin)}m`})`;
  else if (authority) skip = authority;
  else if (curvePct !== null && curvePct > config.maxCurveProgressPct) skip = `curve ${curvePct.toFixed(0)}% done (about to migrate)`;
  else if (impact !== null && impact > config.maxPriceImpactPct) skip = `price impact ${impact.toFixed(1)}%`;
  else if (holders && holders.identical >= 4) skip = bundledReason(holders);
  else if (top10 !== null && top10 > config.maxTop10HolderPct) skip = `top10 hold ${top10.toFixed(0)}%`;
  else if (devPct !== null && devPct > config.maxDevHoldPct) skip = `dev holds ${devPct.toFixed(0)}%`;
  else if (snipePct !== null && snipePct > config.maxLaunchSnipePct) skip = `launch snipers took ${snipePct.toFixed(0)}%`;
  else if (devSoldPct !== null && devSoldPct > config.maxDevSoldPct) skip = `dev already sold ${devSoldPct.toFixed(0)}% of launch buy`;
  else if (rt && (!rt.sellable || rt.lossPct > config.maxRoundTripLossPct)) skip = roundTripReason(rt);
  // Not priced in SOL: our only SOL price is DexScreener's USD price converted, so confirm it against
  // an executable Jupiter quote before trusting it.
  if (!skip && q && (q.nonStandard || q.nonSolPool)) {
    const jq = await jupBuyQuote(mint, config.positionSizeSol).catch(() => null);
    const gap = jq && q.priceSol > 0 ? Math.abs(jq.priceSol / q.priceSol - 1) * 100 : null;
    if (gap === null) skip = "not SOL-priced and no Jupiter quote to verify it";
    else if (gap > config.copyNonSolMaxGapPct) skip = `price sources disagree by ${gap.toFixed(0)}% (not SOL-priced)`;
  }
  return { q, symbol, ageMin, top10, devPct, snipePct, curvePct, impact, skip };
}

const evaluating = new Set<string>(); // coins being evaluated right now

/**
 * One evaluation per coin at a time. Several watched wallets often buy in the same second; each buy
 * used to start its own evaluation, and all of them passed "already holding" before the first position
 * existed (27Z4sokp was bought 6 times within 3.5s). A buy that arrives mid-evaluation is covered by it.
 */
export async function evaluate(mint: string, trigger: { wallet: string; kind: "BUY" | "CREATE" }) {
  if (evaluating.has(mint)) return;
  evaluating.add(mint);
  try {
    await evaluateOnce(mint, trigger);
  } finally {
    evaluating.delete(mint);
  }
}

async function evaluateOnce(mint: string, trigger: { wallet: string; kind: "BUY" | "CREATE" }) {
  const mode = await strategyMode("copy");
  if (mode === "off") return;
  const since = new Date(Date.now() - config.confluenceWindowMin * 60_000);
  const buys = await db.walletEvent.findMany({
    where: { mint, side: { in: ["BUY", "CREATE"] }, ts: { gte: since } },
    distinct: ["wallet"],
    select: { wallet: true },
  });
  const watched = await db.wallet.findMany({
    where: { address: { in: buys.map((b) => b.wallet) }, status: "WATCHING" },
    select: { address: true, kind: true, score: true },
  });
  const wallets = watched.map((w) => w.address);
  const launcherCreate =
    trigger.kind === "CREATE" &&
    config.launcherSoloSignal &&
    watched.some((w) => w.address === trigger.wallet && w.kind === "LAUNCHER");

  if (wallets.length < config.minConfluence && !launcherCreate) return;
  // Wallets that always buy together are one decision, not several (lib/linked).
  const groups = config.copyMergeLinked && wallets.length >= 2 ? await independentGroups(wallets) : wallets.map((w) => [w]);
  if (groups.length < config.minConfluence && !launcherCreate) {
    const prevLinked = await db.signal.findFirst({ where: { mint, skipReason: { startsWith: "linked wallets" }, createdAt: { gte: new Date(Date.now() - 30 * 60_000) } } });
    if (!prevLinked)
      await db.signal.create({
        data: {
          mint,
          reason: `${wallets.length} smart wallets bought, but they trade as ${groups.length} (linked)`,
          wallets,
          confluence: groups.length,
          decision: "SKIPPED",
          skipReason: `linked wallets: ${groups.filter((g) => g.length > 1).map((g) => g.map((w) => w.slice(0, 4)).join("+")).join(", ")} always buy together`,
        },
      });
    return;
  }

  // Don't re-signal the same coin unless more wallets piled in.
  const prev = await db.signal.findFirst({
    where: { mint, createdAt: { gte: new Date(Date.now() - 30 * 60_000) } },
    orderBy: { createdAt: "desc" },
  });
  if (prev && (prev.decision === "TAKEN" || prev.confluence >= wallets.length)) return;

  const reason = launcherCreate
    ? `launcher ${short(trigger.wallet)} created a coin`
    : `${wallets.length} smart wallets bought within ${config.confluenceWindowMin}m`;

  const { q, symbol, ageMin, top10, devPct, snipePct, curvePct, impact, skip: tokenSkip } = await checkToken(mint);
  let skip = tokenSkip;
  if (!skip) skip = await riskBlock(mint);

  const signal = await db.signal.create({
    data: {
      mint,
      symbol,
      reason,
      wallets,
      confluence: wallets.length,
      mcapUsd: q?.mcapUsd,
      ageMin: ageMin ?? undefined,
      top10Pct: top10 ?? undefined,
      devHoldPct: devPct ?? undefined,
      snipePct: snipePct ?? undefined,
      curvePct: curvePct ?? undefined,
      impactPct: impact ?? undefined,
      priceSol: q?.priceSol,
      decision: skip ? "SKIPPED" : "TAKEN",
      skipReason: skip,
    },
  });
  await db.wallet.updateMany({ where: { address: { in: wallets } }, data: { signalHits: { increment: 1 } } });
  await log("signal", `${mint} ${reason} → ${skip ? `SKIP (${skip})` : "TAKE"}`);

  if (skip) {
    await notify(`⚪️ Signal skipped: ${symbol ?? short(mint)}\n${reason}\nReason: ${skip}`);
    return;
  }
  const pos = await openPosition({ mint, symbol, priceSol: q!.priceSol, triggerWallets: wallets, mode }).catch(async (e) => {
    await log("trade", `buy failed ${mint}: ${(e as Error).message}`);
    return null;
  });
  if (pos) await db.signal.update({ where: { id: signal.id }, data: { positionId: pos.id } });
}
