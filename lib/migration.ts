/**
 * Migration strategy — buys pump.fun coins that just graduated to PumpSwap, but only after the
 * migration-sniper wave has passed and the coin shows it's holding up.
 *
 * Most graduates collapse (one 60-day study: 91% fell to ≤20% of their migration price), so the
 * edge has to come from filtering. Every graduation is recorded as a Signal (taken or skipped,
 * with the reason), and shadow-tracked afterwards, which doubles as the dataset for tuning.
 *
 * Two pump.fun mechanics shape the rules:
 *  - Every standard coin graduates at the same price: 85 SOL / 206.9M tokens move into the pool.
 *    That's the reference; the graduation price also acts as resistance (curve buyers exit at breakeven).
 *  - BOOST: for ~5 minutes after migration pump.fun itself buys the coin back and burns it. Buy counts
 *    and price action inside that window are protocol-driven, so we judge only what happens after it.
 *
 * Flow: PumpPortal migrate event → wait MIGRATION_DELAY_SEC (past the BOOST window) → checks → buy.
 */
import { config } from "./config";
import { db, log } from "./db";
import { jupBuyQuote, pumpSwapPair, quotes, roundTrip, roundTripReason, solUsd } from "./market";
import { strategyMode } from "./modes";
import { openPosition, riskBlock } from "./positions";
import { type PortalTrade, startPortal } from "./pumpportal";
import { bundledReason, devHoldPct, holderStats, mintRisk, tokenAge } from "./signals";
import { PublicKey } from "@solana/web3.js";
import { conn, feePayer, getBondingCurves, getParsedTxs, poolSolVault, PUMP_TOTAL_SUPPLY, sleep, tokenDeltas, withRetry, WSOL } from "./solana";
import { notify, short } from "./telegram";
import { devReputation, devRepText } from "./devrep";
import { socialLinks } from "./socials";

const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
/** SOL per token at graduation for a standard coin (85 SOL and 206.9M tokens seed the pool). */
export const GRADUATION_PRICE_SOL = 85 / 206_900_000;

/** Fallback when DexScreener hasn't indexed the pair yet: the pump-amm pool account in the migrate tx. */
async function poolFromMigrateTx(sig: string): Promise<string | null> {
  const tx = await withRetry(() => conn().getParsedTransaction(sig, { maxSupportedTransactionVersion: 1 })).catch(() => null);
  const keys = tx?.transaction.message.accountKeys.map((k) => k.pubkey) ?? [];
  if (!keys.length) return null;
  const infos = await conn().getMultipleAccountsInfo(keys).catch(() => []);
  const i = infos.findIndex((a) => a?.owner.toBase58() === PUMP_AMM && a.data.length >= 300);
  return i >= 0 ? keys[i].toBase58() : null;
}

async function poolSol(pool: string): Promise<number | null> {
  const r = await conn().getTokenAccountBalance(poolSolVault(pool), "confirmed").catch(() => null);
  return r?.value.uiAmount ?? null;
}

/** Real (non-BOOST) order flow on the pool since `sinceSec`: buys/sells by the pool's SOL change, and
 *  distinct traders (the strongest early survival signal in the research). */
async function organicFlow(pool: string, sinceSec: number) {
  const poolKey = new PublicKey(pool);
  const sigs = await withRetry(() => conn().getSignaturesForAddress(poolKey, { limit: 300 })).catch(() => []);
  const recent = sigs.filter((x) => !x.err && (x.blockTime ?? 0) >= sinceSec).slice(0, 150);
  const txs = (await getParsedTxs(recent.map((x) => x.signature))).filter((t): t is NonNullable<typeof t> => !!t);
  let buys = 0;
  let sells = 0;
  const traders = new Set<string>();
  for (const tx of txs) {
    const d = tokenDeltas(tx).find((x) => x.owner === pool && x.mint === WSOL);
    if (!d) continue;
    if (d.delta > 0) buys++;
    else sells++;
    traders.add(feePayer(tx));
  }
  return { buys, sells, traders: traders.size, truncated: recent.length === 150 };
}

/** Watched (vetted) wallets currently holding the coin, from the listener's event log. */
async function smartHolders(mint: string): Promise<string[]> {
  const events = await db.walletEvent.findMany({
    where: { mint, side: { in: ["BUY", "SELL", "CREATE"] } },
    select: { wallet: true, tokenDelta: true },
  });
  const net = new Map<string, number>();
  for (const e of events) net.set(e.wallet, (net.get(e.wallet) ?? 0) + e.tokenDelta);
  const holders = [...net.entries()].filter(([, n]) => n > 0).map(([w]) => w);
  if (!holders.length) return [];
  const watched = await db.wallet.findMany({ where: { address: { in: holders }, status: "WATCHING" }, select: { address: true } });
  return watched.map((w) => w.address);
}

const seen = new Set<string>();

async function recordGraduate(mint: string) {
  const creator = (await getBondingCurves([mint]).catch(() => new Map())).get(mint)?.creator ?? null;
  await db.token.upsert({ where: { mint }, create: { mint, creator }, update: creator ? { creator } : {} });
}

async function handleMigration(m: PortalTrade) {
  if ((await strategyMode("migration")) === "off") return;
  const mint = m.mint;
  const size = config.migrationSizeSol;
  const t0 = Date.now();
  const migratedSec = Math.floor(t0 / 1000);
  // Metadata doesn't change: read the social links while we wait out the BOOST window.
  const socialsP = socialLinks(mint).catch(() => null);

  await sleep(config.migrationDelaySec * 1000);
  const mode = await strategyMode("migration"); // may have been toggled while waiting
  if (mode === "off") return;

  const [now, pair] = await Promise.all([jupBuyQuote(mint, size), pumpSwapPair(mint)]);
  const pool = pair?.pairAddress ?? (await poolFromMigrateTx(m.signature));
  const curve = (await getBondingCurves([mint]).catch(() => new Map())).get(mint);
  const [sol, smart, risk, holders, devPct, solPrice, age, spot] = await Promise.all([
    pool ? poolSol(pool) : Promise.resolve(null),
    smartHolders(mint),
    mintRisk(mint),
    holderStats(mint, pool ? [pool] : []),
    devHoldPct(mint, curve?.creator),
    solUsd(),
    tokenAge(mint),
    quotes([mint]).then((q) => q.get(mint)?.priceSol ?? null).catch(() => null),
  ]);
  const [socials, dev] = await Promise.all([socialsP, devReputation(mint, curve?.creator).catch(() => null)]);
  const top10 = holders?.top10Pct ?? null;
  // Age from the curve's history; null means 1000+ curve txs, i.e. a long organic run before graduating.
  const ageMin = age.ageMin;
  const fillMin = ageMin !== null ? ageMin - (Date.now() - t0) / 60_000 : null; // launch → graduation

  // Versus the fixed graduation price (Jupiter's quote includes fees/impact, so this is slightly conservative).
  const vsGradPct = now ? (now.priceSol / GRADUATION_PRICE_SOL - 1) * 100 : null;
  const symbol = pair?.baseToken.symbol ?? null;
  const mcapUsd = now ? now.priceSol * PUMP_TOTAL_SUPPLY * solPrice : (pair?.marketCap ?? null);

  let skip: string | null = null;
  if (!now) skip = "no swap route";
  else if (sol === null) skip = "pool not found";
  else if (sol < config.migrationMinPoolSol) skip = `pool only ${sol.toFixed(1)} SOL`;
  else if (vsGradPct! < -config.migrationMaxDropPct) skip = `${vsGradPct!.toFixed(0)}% vs graduation price after BOOST`;
  else if (vsGradPct! > config.migrationMaxPumpPct) skip = `already +${vsGradPct!.toFixed(0)}% vs graduation price`;
  else if (age.unknown) skip = "age unknown (history lookup failed)";
  else if (fillMin !== null && fillMin < config.migrationMinFillMin)
    skip = `graduated ${Math.max(0, fillMin).toFixed(0)}m after launch (manufactured)`;
  else if (holders && holders.identical >= 4) skip = bundledReason(holders);
  else if (risk) skip = risk;
  else if (top10 !== null && top10 > config.maxTop10HolderPct) skip = `top10 hold ${top10.toFixed(0)}%`;
  else if (devPct !== null && devPct > config.maxDevHoldPct) skip = `dev holds ${devPct.toFixed(0)}%`;
  else if (config.migrationMinSocials > 0 && (socials?.count ?? 0) < config.migrationMinSocials)
    skip = `socials: ${socials ? socials.count : "?"}/${config.migrationMinSocials} links`;
  else if (config.migrationRequireProvenDev && !dev?.proven)
    skip = dev ? `not a proven dev (${dev.grads} prior graduates, ${dev.recent} launches in 7d)` : "not a proven dev (creator unknown)";
  else if (smart.length < config.migrationMinSmartWallets) skip = `${smart.length} smart wallets holding`;
  if (!skip) {
    const rt = await roundTrip(mint, size).catch(() => null);
    if (rt && (!rt.sellable || rt.lossPct > config.maxRoundTripLossPct)) skip = roundTripReason(rt);
  }

  // Order flow after the BOOST window: only computed for coins that passed everything else (it costs RPC).
  let flow: Awaited<ReturnType<typeof organicFlow>> | null = null;
  if (!skip && pool) {
    flow = await organicFlow(pool, migratedSec + config.migrationBoostSec).catch(() => null);
    if (flow) {
      const ratio = flow.buys / Math.max(1, flow.sells);
      if (flow.traders < config.migrationMinTraders) skip = `only ${flow.traders} traders after BOOST`;
      else if (ratio < config.migrationMinBuyRatio) skip = `weak buying after BOOST (${flow.buys} buys / ${flow.sells} sells)`;
    }
  }
  if (!skip) skip = await riskBlock(mint, "migration");

  const parts = [
    fillMin !== null ? `graduated ${Math.max(0, fillMin).toFixed(0)}m after launch` : "graduated (long run)",
    sol !== null ? `pool ${sol.toFixed(0)} SOL` : null,
    vsGradPct !== null ? `${vsGradPct >= 0 ? "+" : ""}${vsGradPct.toFixed(0)}% vs grad price` : null,
    flow ? `${flow.buys}/${flow.sells} buys/sells, ${flow.traders} traders after BOOST` : null,
    smart.length ? `${smart.length} smart holding` : null,
    socials ? (socials.count ? `socials: ${socials.kinds.join(", ")}` : "no socials") : null,
    dev ? devRepText(dev) : null,
  ].filter(Boolean);

  const signal = await db.signal.create({
    data: {
      strategy: "migration",
      mint,
      symbol,
      reason: parts.join(" · "),
      wallets: smart,
      confluence: smart.length,
      mcapUsd: mcapUsd ?? undefined,
      ageMin: ageMin ?? undefined,
      top10Pct: top10 ?? undefined,
      devHoldPct: devPct ?? undefined,
      curvePct: 100,
      impactPct: now?.impactPct,
      devGrads: dev?.grads,
      devRecent: dev?.recent,
      socials: socials?.count,
      priceSol: spot ?? undefined,
      decision: skip ? "SKIPPED" : "TAKEN",
      skipReason: skip,
    },
  });
  if (skip) return; // skips are frequent here: logged as signals, not pushed to Telegram

  await log("signal", `migration ${symbol ?? mint}: ${parts.join(" · ")} → TAKE (${mode})`);
  const pos = await openPosition({
    strategy: "migration",
    mode: mode === "live" ? "live" : "paper",
    mint,
    symbol,
    priceSol: now!.priceSol,
    sizeSol: size,
    triggerWallets: smart,
    pool,
  }).catch(async (e) => {
    await log("trade", `migration buy failed ${mint}: ${(e as Error).message}`);
    await notify(`⚠️ Migration buy failed: ${symbol ?? short(mint)}\n${(e as Error).message}`);
    return null;
  });
  if (pos) await db.signal.update({ where: { id: signal.id }, data: { positionId: pos.id } });
}

export function startMigrationStrategy() {
  startPortal({
    onMigrate: (m) => {
      if (seen.has(m.mint)) return;
      seen.add(m.mint);
      // Every graduate is recorded with its creator: a future winner for discovery to study (see
      // collectWinners), and the graduation history behind the dev-reputation check.
      recordGraduate(m.mint).catch(() => {});
      if (seen.size > 5000) seen.delete(seen.values().next().value!);
      handleMigration(m).catch((e) => log("signal", `migration ${m.mint} failed: ${(e as Error).message}`));
    },
  });
}
