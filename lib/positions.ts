/** Opening, managing and closing positions (take-profit ladder, stop-loss, time exit, mirror exit). */
import type { Position } from "@/generated/prisma/client";
import { config } from "./config";
import { db, getKv, log, setKv } from "./db";
import { buy, type ExecMode, sell } from "./executor";
import type { Strategy } from "./modes";
import { jupSellPrice, quotes } from "./market";
import { syncPriceFeeds } from "./pricefeed";
import { notify, short } from "./telegram";

const startOfDay = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

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
  const cap = strategy === "migration" ? config.migrationMaxOpen : config.maxOpenPositions;
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
}): Promise<Position | null> {
  const strategy = opts.strategy ?? "copy";
  const fill = await buy(opts.mint, opts.sizeSol ?? config.positionSizeSol, opts.priceSol, opts.mode);
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
  await log("trade", `BUY ${opts.symbol ?? opts.mint} ${fill.sol} SOL (${strategy}, ${p.mode})`);
  const why = strategy === "migration" ? "Graduated to PumpSwap" : `Wallets: ${opts.triggerWallets.map(short).join(", ")}`;
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
  const fill = await sell(p.mint, tokens, priceSol, close, p.mode === "LIVE" ? "live" : "paper");
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

function exitRules(strategy: string) {
  return strategy === "migration"
    ? { stopLossPct: config.migrationStopLossPct, maxHoldMin: config.migrationMaxHoldMin, tpLevels: config.migrationTpLevels }
    : { stopLossPct: config.stopLossPct, maxHoldMin: config.maxHoldMin, tpLevels: config.tpLevels };
}

/** Applies stop-loss / time exit / take-profit ladder at `price`. Re-reads the position so concurrent
 *  triggers (poll + live feed) never act on a stale take-profit level. */
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
    const gainPct = (price / p.entryPriceSol - 1) * 100;
    const heldMin = (Date.now() - p.openedAt.getTime()) / 60_000;
    const rules = exitRules(p.strategy);

    if (gainPct <= -rules.stopLossPct) {
      await sellPart(p, p.remainingTokens, price, `stop-loss ${gainPct.toFixed(0)}%`, true);
      return;
    }
    if (heldMin >= rules.maxHoldMin) {
      await sellPart(p, p.remainingTokens, price, `time exit ${Math.round(heldMin)}m`, true);
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

/** Runs every few seconds: polls prices (covers migrated coins), handles manual closes, syncs live feeds. */
export async function managePositions() {
  const open = await db.position.findMany({ where: { status: "OPEN" } });
  await syncPriceFeeds(open, onLivePrice);
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

/** Called by the listener when a watched wallet sells. Closes if most trigger wallets have exited. */
export async function onTrackedSell(wallet: string, mint: string) {
  if (!config.mirrorExits) return;
  const p = await db.position.findFirst({ where: { mint, status: "OPEN", strategy: "copy" } });
  if (!p || !p.triggerWallets.includes(wallet)) return;
  const sellers = await db.walletEvent.findMany({
    where: { mint, side: "SELL", wallet: { in: p.triggerWallets }, ts: { gte: p.openedAt } },
    distinct: ["wallet"],
    select: { wallet: true },
  });
  if (sellers.length * 2 >= p.triggerWallets.length) {
    await closePosition(p.id, `mirror exit (${sellers.length}/${p.triggerWallets.length} wallets sold)`);
  }
}
