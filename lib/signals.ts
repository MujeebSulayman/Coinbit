/** Signal engine — decides whether a tracked buy (or launch) is worth copying. */
import { PublicKey, type ParsedAccountData } from "@solana/web3.js";
import { config } from "./config";
import { db, log } from "./db";
import { quotes } from "./market";
import { openPosition, riskBlock } from "./positions";
import { bondingCurvePda, conn, PUMP_TOTAL_SUPPLY, withRetry } from "./solana";
import { notify, short } from "./telegram";

async function tokenAgeMin(mint: string, pairCreatedAt?: number): Promise<number | null> {
  const t = await db.token.findUnique({ where: { mint }, select: { launchedAt: true } });
  if (t?.launchedAt) return (Date.now() - t.launchedAt.getTime()) / 60_000;
  const sigs = await withRetry(() => conn().getSignaturesForAddress(bondingCurvePda(mint), { limit: 1000 }));
  if (sigs.length > 0 && sigs.length < 1000) {
    const first = sigs[sigs.length - 1].blockTime;
    if (first) return (Date.now() / 1000 - first) / 60;
  }
  if (pairCreatedAt) return (Date.now() - pairCreatedAt) / 60_000;
  return null; // lots of history → definitely not brand new
}

async function top10HolderPct(mint: string): Promise<number | null> {
  try {
    const largest = await withRetry(() => conn().getTokenLargestAccounts(new PublicKey(mint)));
    const accts = largest.value.slice(0, 15);
    const infos = await conn().getMultipleParsedAccounts(accts.map((a) => a.address));
    const curve = bondingCurvePda(mint).toBase58();
    let total = 0;
    let counted = 0;
    infos.value.forEach((info, i) => {
      const owner = (info?.data as ParsedAccountData | undefined)?.parsed?.info?.owner as string | undefined;
      if (owner === curve || counted >= 10) return;
      total += accts[i].uiAmount ?? 0;
      counted++;
    });
    return (total / PUMP_TOTAL_SUPPLY) * 100;
  } catch {
    return null;
  }
}

export async function evaluate(mint: string, trigger: { wallet: string; kind: "BUY" | "CREATE" }) {
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

  // Don't re-signal the same coin unless more wallets piled in.
  const prev = await db.signal.findFirst({
    where: { mint, createdAt: { gte: new Date(Date.now() - 30 * 60_000) } },
    orderBy: { createdAt: "desc" },
  });
  if (prev && (prev.decision === "TAKEN" || prev.confluence >= wallets.length)) return;

  const reason = launcherCreate
    ? `launcher ${short(trigger.wallet)} created a coin`
    : `${wallets.length} smart wallets bought within ${config.confluenceWindowMin}m`;

  const q = (await quotes([mint])).get(mint);
  const [ageMin, top10] = await Promise.all([tokenAgeMin(mint, q?.pairCreatedAt), top10HolderPct(mint)]);
  const symbol = q?.symbol ?? null;

  let skip: string | null = null;
  if (!q || q.priceSol <= 0) skip = "no price";
  else if (q.mcapUsd > config.maxEntryMcapUsd) skip = `mcap $${Math.round(q.mcapUsd).toLocaleString()} too high`;
  else if (ageMin === null || ageMin > config.maxTokenAgeMin) skip = `too old (${ageMin === null ? "?" : Math.round(ageMin)}m)`;
  else if (top10 !== null && top10 > config.maxTop10HolderPct) skip = `top10 hold ${top10.toFixed(0)}%`;
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
  const pos = await openPosition({ mint, symbol, priceSol: q!.priceSol, triggerWallets: wallets }).catch(async (e) => {
    await log("trade", `buy failed ${mint}: ${(e as Error).message}`);
    return null;
  });
  if (pos) await db.signal.update({ where: { id: signal.id }, data: { positionId: pos.id } });
}
