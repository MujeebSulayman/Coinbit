/**
 * Blocks watched wallets whose copies don't work, using our own copy-trade results.
 *
 * The discovery rule only excludes a wallet once its copies have lost 1 SOL, which takes dozens of
 * 0.3-SOL trades. Meanwhile Bup4…+Bvka… triggered 13 copies with 1 win: brand-new coins they sold
 * within seconds, so we bought late and sold into their exit. Two rules, both from Settings:
 *  - losers: at least N copies and a win rate under X%
 *  - flippers: at least N copies, most of them closed within 10s by a mirror exit, at a net loss
 * Wallets allowed manually from the dashboard are never blocked.
 */
import { config } from "./config";
import { db, log } from "./db";

const FLIP_SEC = 10;

export function judgeWallet(trades: { pnl: number; quickMirror: boolean }[], cfg: Pick<typeof config, "copyAutoBlockMinTrades" | "copyAutoBlockMaxWinPct" | "copyAutoBlockFlipPct">) {
  const n = trades.length;
  if (n < cfg.copyAutoBlockMinTrades) return null;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const net = trades.reduce((s, t) => s + t.pnl, 0);
  const flips = trades.filter((t) => t.quickMirror).length;
  if (cfg.copyAutoBlockMaxWinPct > 0 && (wins / n) * 100 < cfg.copyAutoBlockMaxWinPct)
    return `copies lose: ${wins}/${n} won (${net >= 0 ? "+" : ""}${net.toFixed(2)} SOL)`;
  if (cfg.copyAutoBlockFlipPct > 0 && (flips / n) * 100 >= cfg.copyAutoBlockFlipPct && net < 0)
    return `flipper: sold within ${FLIP_SEC}s on ${flips}/${n} copies (${net.toFixed(2)} SOL)`;
  return null;
}

/** Reviews every wallet that has triggered copies (or just `only`), and blocks the ones that fail. */
export async function reviewCopyWallets(only?: string[]) {
  const ps = await db.position.findMany({
    where: { strategy: "copy", status: "CLOSED", ...(only ? { triggerWallets: { hasSome: only } } : {}) },
    select: { triggerWallets: true, realizedSol: true, sizeSol: true, openedAt: true, closedAt: true, exitReason: true },
  });
  const per = new Map<string, { pnl: number; quickMirror: boolean }[]>();
  for (const p of ps) {
    const t = {
      pnl: p.realizedSol - p.sizeSol,
      quickMirror: !!p.exitReason?.startsWith("mirror exit") && !!p.closedAt && p.closedAt.getTime() - p.openedAt.getTime() <= FLIP_SEC * 1000,
    };
    for (const w of p.triggerWallets) if (!only || only.includes(w)) per.set(w, [...(per.get(w) ?? []), t]);
  }
  const candidates = await db.wallet.findMany({ where: { address: { in: [...per.keys()] }, status: { not: "EXCLUDED" }, allowed: false }, select: { address: true } });
  let blocked = 0;
  for (const { address } of candidates) {
    const why = judgeWallet(per.get(address)!, config);
    if (!why) continue;
    await db.wallet.update({ where: { address }, data: { status: "EXCLUDED", excludeReason: why } });
    await log("discovery", `blocked ${address.slice(0, 4)}…${address.slice(-4)}: ${why}`);
    blocked++;
  }
  return blocked;
}
