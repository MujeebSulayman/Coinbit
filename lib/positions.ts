/** Opening, managing and closing positions (take-profit ladder, stop-loss, time exit, mirror exit). */
import type { Position } from "@/generated/prisma/client";
import { config } from "./config";
import { db, getKv, log, setKv } from "./db";
import { buy, type ExecMode, type FastFill, type Fill, sell, traderAddress } from "./executor";
import { type InsiderDump, syncInsiderWatch } from "./insiders";
import type { Strategy } from "./modes";
import { jupSellPrice, quotes } from "./market";
import { flowStats, syncPriceFeeds } from "./pricefeed";
import { notify, short } from "./telegram";
import { isStagnant, quoteShock, stopLevel as stopLevelPure } from "./exits";
import { startOfDay } from "./time";

export async function isPaused() {
  return (await getKv("trading:paused")) === "true";
}

export async function todaysPnlSol(): Promise<number> {
  const closed = await db.position.findMany({
    where: { status: "CLOSED", closedAt: { gte: startOfDay() } },
    select: { realizedSol: true, sizeSol: true },
  });
  return closed.reduce((s, p) => s + p.realizedSol - p.sizeSol, 0);
}

/** Checks risk limits. Returns a reason string if we must not open a new trade.
 *  The pause switch and daily loss limit are shared; open-position caps are per strategy. */
export async function riskBlock(mint: string, strategy: Strategy = "copy"): Promise<string | null> {
  if (await isPaused()) return "trading paused";
  const open = await db.position.findMany({ where: { status: "OPEN" }, select: { mint: true, strategy: true } });
  if (open.some((p) => p.mint === mint)) return "already holding";
  const cap = strategy === "migration" ? config.migrationMaxOpen : strategy === "launch" ? config.launchMaxOpen : config.maxOpenPositions;
  if (open.filter((p) => p.strategy === strategy).length >= cap) return "max open positions";
  const pnl = await todaysPnlSol();
  if (pnl <= -config.dailyLossLimitSol) {
    await setKv("trading:paused", "true");
    await notify(`🛑 Daily loss limit hit (${pnl.toFixed(3)} SOL). Trading paused.`);
    return "daily loss limit";
  }
  return null;
}

export async function openPosition(opts: {
  mint: string;
  symbol?: string | null;
  priceSol: number;
  triggerWallets: string[];
  strategy?: Strategy;
  mode: ExecMode;
  sizeSol?: number;
  pool?: string | null;
  /** Launch sniper: a live buy prepared on the fast path (see prepareBuyFast), or a curve-computed paper fill. */
  sendLive?: () => Promise<FastFill>;
  paperTokens?: number;
  onFill?: (f: Fill & { slot?: number | null }) => void;
}): Promise<Position | null> {
  const strategy = opts.strategy ?? "copy";
  const size = opts.sizeSol ?? config.positionSizeSol;
  const fill =
    opts.sendLive && opts.mode === "live" ? await opts.sendLive() : await buy(opts.mint, size, opts.priceSol, opts.mode, opts.paperTokens);
  opts.onFill?.(fill);
  if (fill.tokens <= 0) return null;
  const entry = fill.sol / fill.tokens;
  const p = await db.position.create({
    data: {
      strategy,
      pool: opts.pool ?? undefined,
      mint: opts.mint,
      symbol: opts.symbol,
      mode: opts.mode === "live" ? "LIVE" : "PAPER",
      sizeSol: fill.sol,
      entryPriceSol: entry,
      tokenAmount: fill.tokens,
      remainingTokens: fill.tokens,
      currentPriceSol: entry,
      peakPriceSol: entry,
      triggerWallets: opts.triggerWallets,
      entrySig: fill.signature,
    },
  });
  await db.fill.create({
    data: { positionId: p.id, side: "BUY", tokens: fill.tokens, sol: fill.sol, priceSol: entry, reason: "entry", signature: fill.signature },
  });
  await db.pricePoint.create({ data: { positionId: p.id, priceSol: entry } });
  await log("trade", `BUY ${opts.symbol ?? opts.mint} ${fill.sol} SOL (${strategy}, ${p.mode})`);
  const why =
    strategy === "migration" ? "Graduated to PumpSwap" : strategy === "launch" ? "Launch snipe" : `Wallets: ${opts.triggerWallets.map(short).join(", ")}`;
  await notify(
    `🟢 <b>BUY ${opts.symbol ?? short(opts.mint)}</b> [${strategy} · ${p.mode}]\n${fill.sol} SOL @ ${entry.toExponential(3)}\n${why}\nhttps://pump.fun/coin/${opts.mint}`,
  );
  return p;
}

const selling = new Set<number>(); // positions with a sell in flight

/** Returns the updated position, or null if nothing was sold (already selling or already closed). */
async function sellPart(stale: Position, tokens: number, priceSol: number, reason: string, close: boolean) {
  // Exits can race (stop-loss tick vs. mirror exit vs. manual close): one sell per position at a time.
  if (selling.has(stale.id)) return null;
  selling.add(stale.id);
  try {
    const p = await db.position.findUnique({ where: { id: stale.id } });
    if (!p || p.status !== "OPEN") return null;
    return await doSell(p, tokens, priceSol, reason, close);
  } finally {
    selling.delete(stale.id);
  }
}

async function doSell(p: Position, tokens: number, priceSol: number, reason: string, close: boolean) {
  tokens = Math.min(tokens, p.remainingTokens);
  const fill = await sell(p.mint, tokens, priceSol, close, p.mode === "LIVE" ? "live" : "paper", p.strategy === "launch");
  if (fill.empty) reason = `${reason} (wallet held no tokens)`;
  const remaining = close || fill.empty ? 0 : p.remainingTokens - fill.tokens;
  const realized = p.realizedSol + fill.sol;
  const done = close || !!fill.empty || remaining <= p.tokenAmount * 0.01;
  const updated = await db.position.update({
    where: { id: p.id },
    data: {
      remainingTokens: done ? 0 : remaining,
      realizedSol: realized,
      exitSigs: fill.signature ? { push: fill.signature } : undefined,
      ...(done ? { status: "CLOSED", closedAt: new Date(), exitReason: reason } : {}),
    },
  });
  if (fill.tokens > 0 || fill.sol > 0) {
    await db.fill.create({
      data: {
        positionId: p.id,
        side: "SELL",
        tokens: fill.tokens,
        sol: fill.sol,
        priceSol: fill.tokens > 0 ? fill.sol / fill.tokens : priceSol,
        reason,
        signature: fill.signature,
      },
    });
  }
  const pnl = realized - p.sizeSol;
  await log("trade", `SELL ${p.symbol ?? p.mint} ${fill.sol.toFixed(4)} SOL — ${reason}`);
  await notify(
    `${done ? (pnl >= 0 ? "✅" : "🔴") : "💰"} <b>SELL ${p.symbol ?? short(p.mint)}</b> — ${reason}\n+${fill.sol.toFixed(4)} SOL${done ? `\nPosition PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL` : ""}`,
  );
  if (done) await creditWallets(updated);
  return updated;
}

/** Feeds the result back into the discovery scores of the wallets that triggered the trade. */
async function creditWallets(p: Position) {
  const pnl = p.realizedSol - p.sizeSol;
  const share = pnl / Math.max(1, p.triggerWallets.length);
  for (const w of p.triggerWallets) {
    await db.wallet.updateMany({ where: { address: w }, data: { copyPnlSol: { increment: share } } });
  }
}

export async function closePosition(id: number, reason: string) {
  const p = await db.position.findUnique({ where: { id } });
  if (!p || p.status !== "OPEN") return;
  const q = (await quotes([p.mint])).get(p.mint);
  await sellPart(p, p.remainingTokens, q?.priceSol ?? p.currentPriceSol, reason, true);
}

const checking = new Set<number>(); // positions whose exit rules are being evaluated
const belowStop = new Map<number, number>(); // consecutive price readings below the stop
const lastSample = new Map<number, number>(); // last price-history sample per position
const recentPrices = new Map<number, { t: number; p: number }[]>(); // short window for the quote-shock exit

/** Stop level for the trade page and the exit check (see lib/exits). */
export const stopLevel = (p: { tpHit: number; peakPriceSol: number; entryPriceSol: number }, stopLossPct: number) =>
  stopLevelPure(p, stopLossPct, config);

export function exitRules(strategy: string) {
  if (strategy === "migration")
    return { stopLossPct: config.migrationStopLossPct, maxHoldMin: config.migrationMaxHoldMin, tpLevels: config.migrationTpLevels };
  if (strategy === "launch") return { stopLossPct: config.launchStopLossPct, maxHoldMin: config.launchMaxHoldMin, tpLevels: config.launchTpLevels };
  return { stopLossPct: config.stopLossPct, maxHoldMin: config.maxHoldMin, tpLevels: config.tpLevels };
}

/** Applies the exit rules at `price`. Re-reads the position so concurrent triggers (poll + live feed)
 *  never act on a stale take-profit level. Order: quote shock → stop → momentum fade → time → stagnation → take-profit. */
async function checkExits(id: number, price: number) {
  if (checking.has(id) || price <= 0) return;
  checking.add(id);
  try {
    let p = await db.position.findUnique({ where: { id } });
    if (!p || p.status !== "OPEN") return;
    p = await db.position.update({
      where: { id },
      data: { currentPriceSol: price, peakPriceSol: Math.max(p.peakPriceSol, price) },
    });
    // Price history for the trade page: at most one sample per position every 5s.
    if (Date.now() - (lastSample.get(id) ?? 0) >= 5000) {
      lastSample.set(id, Date.now());
      await db.pricePoint.create({ data: { positionId: id, priceSol: price } });
    }
    const now = Date.now();
    const gainPct = (price / p.entryPriceSol - 1) * 100;
    const heldMin = (now - p.openedAt.getTime()) / 60_000;
    const rules = exitRules(p.strategy);

    // Quote shock: a sudden collapse from the recent high. Acted on at once (no confirmation reading),
    // but only if an independent sell quote for our bag confirms it, so a bad feed reading can't trigger it.
    const window = (recentPrices.get(id) ?? []).filter((x) => now - x.t <= config.quoteShockWindowSec * 1000);
    const drop = quoteShock(window, now, price, config);
    recentPrices.set(id, [...window, { t: now, p: price }]);
    if (drop !== null) {
      const confirmed = await jupSellPrice(p.mint, p.remainingTokens).catch(() => null);
      const high = Math.max(...window.map((x) => x.p));
      if (confirmed && (1 - confirmed / high) * 100 >= config.quoteShockPct) {
        await sellPart(p, p.remainingTokens, confirmed, `quote shock −${drop.toFixed(0)}% in ${config.quoteShockWindowSec}s`, true);
        return;
      }
    }

    const { stopPct, stopKind } = stopLevel(p, rules.stopLossPct);
    if (gainPct <= stopPct) {
      // Require consecutive readings below the stop so a single wick doesn't trigger it.
      const n = (belowStop.get(id) ?? 0) + 1;
      belowStop.set(id, n);
      if (n >= config.stopConfirmTicks) {
        belowStop.delete(id);
        await sellPart(p, p.remainingTokens, price, `${stopKind} ${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(0)}%`, true);
      }
      return;
    }
    belowStop.delete(id);

    // Momentum fade (after the first take-profit): sellers clearly took over in the last window.
    if (p.tpHit >= 1 && config.momentumExit) {
      const f = flowStats(id, config.momentumWindowSec);
      if (f.buys + f.sells >= config.momentumMinTrades && f.sellSol > 0 && f.sellSol >= config.momentumSellRatio * Math.max(f.buySol, 1e-9)) {
        await sellPart(
          p,
          p.remainingTokens,
          price,
          `momentum faded (${config.momentumWindowSec}s: ${f.sellSol.toFixed(1)} SOL sold vs ${f.buySol.toFixed(1)} bought)`,
          true,
        );
        return;
      }
    }

    if (heldMin >= rules.maxHoldMin) {
      await sellPart(p, p.remainingTokens, price, `time exit ${Math.round(heldMin)}m`, true);
      return;
    }
    if (isStagnant({ ...p, heldMin, price }, config)) {
      await sellPart(p, p.remainingTokens, price, `stagnant ${Math.round(heldMin)}m (${gainPct >= 0 ? "+" : ""}${gainPct.toFixed(0)}%)`, true);
      return;
    }
    const level = rules.tpLevels[p.tpHit];
    if (level && gainPct >= level.gainPct) {
      const isLast = p.tpHit === rules.tpLevels.length - 1;
      const updated = await sellPart(p, (p.tokenAmount * level.sellPct) / 100, price, `take-profit +${level.gainPct}%`, isLast);
      if (updated?.status === "OPEN") {
        await db.position.update({ where: { id }, data: { tpHit: { increment: 1 } } });
      }
    }
  } catch (e) {
    await log("trade", `exit error on position ${id}: ${(e as Error).message}`);
  } finally {
    checking.delete(id);
  }
}

const lastLive = new Map<number, number>();
/** Live price from the bonding-curve feed: reacts to every trade, throttled to once per 750ms. */
function onLivePrice(id: number, price: number) {
  const now = Date.now();
  if (now - (lastLive.get(id) ?? 0) < 750) return;
  lastLive.set(id, now);
  checkExits(id, price).catch(() => {});
}

const insiderExited = new Set<number>();
/** A top holder dumped: get out now (once per position). */
function onInsiderDump(id: number, d: InsiderDump) {
  if (insiderExited.has(id)) return;
  insiderExited.add(id);
  const why = d.group
    ? `insider dump: ${d.owner} holders (${d.heldPct.toFixed(1)}% of supply) sold ${d.soldPct.toFixed(0)}%`
    : `insider dump: holder with ${d.heldPct.toFixed(1)}% sold ${d.soldPct.toFixed(0)}%`;
  closePosition(id, why).catch((e) =>
    log("trade", `insider exit on position ${id} failed: ${(e as Error).message}`),
  );
}

/** Starts live price feeds for any new open positions right away, instead of on the next 10s poll
 *  (the launch sniper's trades are decided in seconds). */
export async function watchOpenPositions() {
  const open = await db.position.findMany({ where: { status: "OPEN" } });
  await syncPriceFeeds(open, onLivePrice);
}

/** Runs every few seconds: polls prices (covers migrated coins), handles manual closes, syncs live feeds. */
export async function managePositions() {
  const open = await db.position.findMany({ where: { status: "OPEN" } });
  await syncPriceFeeds(open, onLivePrice);
  await syncInsiderWatch(open, traderAddress(), onInsiderDump).catch(() => {});
  if (open.length === 0) return;
  const q = await quotes([...new Set(open.map((p) => p.mint))]);

  for (const p of open) {
    const manual = await getKv(`close:${p.id}`);
    if (manual) {
      await db.kv.delete({ where: { key: `close:${p.id}` } }).catch(() => {});
      await closePosition(p.id, "manual close");
      continue;
    }
    const quote = q.get(p.mint);
    // Graduated coins: price by what selling our bag would actually return.
    const price = quote && !quote.onCurve ? ((await jupSellPrice(p.mint, p.remainingTokens)) ?? quote.priceSol) : quote?.priceSol;
    if (price && price > 0) await checkExits(p.id, price);
  }
}

/** Called by the listener when a watched wallet sells. Closes only once a strict majority of the
 *  trigger wallets have sold (2 of 2, 2 of 3, 3 of 4…), so one wallet trimming doesn't shake us out. */
export async function onTrackedSell(wallet: string, mint: string) {
  if (!config.mirrorExits) return;
  const p = await db.position.findFirst({ where: { mint, status: "OPEN", strategy: "copy" } });
  if (!p || !p.triggerWallets.includes(wallet)) return;
  const sellers = await db.walletEvent.findMany({
    where: { mint, side: "SELL", wallet: { in: p.triggerWallets }, ts: { gte: p.openedAt } },
    distinct: ["wallet"],
    select: { wallet: true },
  });
  if (sellers.length * 2 > p.triggerWallets.length) {
    await closePosition(p.id, `mirror exit (${sellers.length}/${p.triggerWallets.length} wallets sold)`);
  }
}
