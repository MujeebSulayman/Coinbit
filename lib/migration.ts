/**
 * Migration strategy — buys pump.fun coins that just graduated to PumpSwap, but only after the
 * migration-sniper wave has passed and the coin shows it's holding up.
 *
 * Most graduates collapse (one 60-day study: 91% fell to ≤20% of their migration price), so the
 * edge has to come from filtering. Every graduation is recorded as a Signal (taken or skipped,
 * with the reason), which doubles as the dataset for tuning these rules.
 *
 * Flow: PumpPortal migrate event → +5s reference price → wait MIGRATION_DELAY_SEC → checks → buy.
 */
import { config } from "./config";
import { db, log } from "./db";
import { jupBuyQuote, pumpSwapPair, solUsd } from "./market";
import { strategyMode } from "./modes";
import { openPosition, riskBlock } from "./positions";
import { type PortalTrade, startPortal } from "./pumpportal";
import { bundledReason, devHoldPct, holderStats, mintRisk, tokenAge } from "./signals";
import { conn, getBondingCurves, poolSolVault, PUMP_TOTAL_SUPPLY, sleep, withRetry } from "./solana";
import { notify, short } from "./telegram";

const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

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

async function handleMigration(m: PortalTrade) {
  if ((await strategyMode("migration")) === "off") return;
  const mint = m.mint;
  const size = config.migrationSizeSol;
  const t0 = Date.now();

  await sleep(5000);
  const ref = await jupBuyQuote(mint, size); // price right after migration
  await sleep(Math.max(0, config.migrationDelaySec * 1000 - (Date.now() - t0)));

  const mode = await strategyMode("migration"); // may have been toggled while waiting
  if (mode === "off") return;

  const [now, pair] = await Promise.all([jupBuyQuote(mint, size), pumpSwapPair(mint)]);
  const pool = pair?.pairAddress ?? (await poolFromMigrateTx(m.signature));
  const curve = (await getBondingCurves([mint]).catch(() => new Map())).get(mint);
  const [sol, smart, risk, holders, devPct, solPrice, age] = await Promise.all([
    pool ? poolSol(pool) : Promise.resolve(null),
    smartHolders(mint),
    mintRisk(mint),
    holderStats(mint, pool ? [pool] : []),
    devHoldPct(mint, curve?.creator),
    solUsd(),
    tokenAge(mint),
  ]);
  const top10 = holders?.top10Pct ?? null;
  // Age from the curve's history; null means 1000+ curve txs, i.e. a long organic run before graduating.
  const ageMin = age.ageMin;
  const fillMin = ageMin !== null ? ageMin - (Date.now() - t0) / 60_000 : null; // launch → graduation

  const changePct = ref && now ? (now.priceSol / ref.priceSol - 1) * 100 : null;
  const flow = pair?.txns?.m5;
  const ratio = flow ? flow.buys / Math.max(1, flow.sells) : null;
  const symbol = pair?.baseToken.symbol ?? null;
  const mcapUsd = now ? now.priceSol * PUMP_TOTAL_SUPPLY * solPrice : (pair?.marketCap ?? null);

  let skip: string | null = null;
  if (!now) skip = "no swap route";
  else if (sol === null) skip = "pool not found";
  else if (sol < config.migrationMinPoolSol) skip = `pool only ${sol.toFixed(1)} SOL`;
  else if (changePct !== null && changePct < -config.migrationMaxDropPct) skip = `dumped ${changePct.toFixed(0)}% since migration`;
  else if (changePct !== null && changePct > config.migrationMaxPumpPct) skip = `already up ${changePct.toFixed(0)}%`;
  else if (ratio !== null && ratio < config.migrationMinBuyRatio) skip = `weak buying (${flow!.buys} buys / ${flow!.sells} sells)`;
  else if (fillMin !== null && fillMin < config.migrationMinFillMin)
    skip = `graduated ${Math.max(0, fillMin).toFixed(0)}m after launch (manufactured)`;
  else if (holders && holders.identical >= 4) skip = bundledReason(holders);
  else if (risk) skip = risk;
  else if (top10 !== null && top10 > config.maxTop10HolderPct) skip = `top10 hold ${top10.toFixed(0)}%`;
  else if (devPct !== null && devPct > config.maxDevHoldPct) skip = `dev holds ${devPct.toFixed(0)}%`;
  else if (smart.length < config.migrationMinSmartWallets) skip = `${smart.length} smart wallets holding`;
  if (!skip) skip = await riskBlock(mint, "migration");

  const parts = [
    fillMin !== null ? `graduated ${Math.max(0, fillMin).toFixed(0)}m after launch` : "graduated (long run)",
    sol !== null ? `pool ${sol.toFixed(0)} SOL` : null,
    changePct !== null ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(0)}% since` : null,
    flow ? `${flow.buys}/${flow.sells} buys/sells 5m` : null,
    smart.length ? `${smart.length} smart holding` : null,
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
      if (seen.size > 5000) seen.delete(seen.values().next().value!);
      handleMigration(m).catch((e) => log("signal", `migration ${m.mint} failed: ${(e as Error).message}`));
    },
  });
}
