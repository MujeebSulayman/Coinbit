/** Strategy evaluation: the numbers that say whether a strategy is worth real money. */
import { db } from "./db";

export const MIN_TRADES = 50;

/** "stop-loss -26%" → "stop-loss", "mirror exit (2/3 wallets sold)" → "mirror exit". */
const exitKind = (r: string | null) =>
  (r ?? "unknown")
    .replace(/\(.*\)/g, "")
    .replace(/[-+]?\d+(\.\d+)?\s*(%|m|SOL)?/g, "")
    .trim();

/** Skip reasons with the numbers removed, so the same rule groups together. */
const reasonKind = (r: string | null) =>
  (r ?? "—")
    .replace(/\$[\d,]+/g, "$N")
    .replace(/[-+]?\d+(\.\d+)?/g, "N")
    .replace(/\s+/g, " ")
    .trim();

export type StrategyPerf = Awaited<ReturnType<typeof strategyPerf>>;

export async function strategyPerf(strategy: string) {
  const closed = await db.position.findMany({
    where: { strategy, status: "CLOSED" },
    orderBy: { closedAt: "asc" },
    select: { realizedSol: true, sizeSol: true, exitReason: true, mode: true },
  });
  const pnls = closed.map((p) => p.realizedSol - p.sizeSol);
  const wins = pnls.filter((x) => x > 0);
  const losses = pnls.filter((x) => x <= 0);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  const total = sum(pnls);

  let peak = 0;
  let cum = 0;
  let maxDrawdown = 0;
  for (const x of pnls) {
    cum += x;
    peak = Math.max(peak, cum);
    maxDrawdown = Math.max(maxDrawdown, peak - cum);
  }

  const byExit = new Map<string, { n: number; pnl: number }>();
  closed.forEach((p, i) => {
    const k = exitKind(p.exitReason);
    const e = byExit.get(k) ?? { n: 0, pnl: 0 };
    e.n++;
    e.pnl += pnls[i];
    byExit.set(k, e);
  });

  const lossSum = Math.abs(sum(losses));
  const avgSize = closed.length ? sum(closed.map((p) => p.sizeSol)) / closed.length : 0;
  const metrics = {
    trades: closed.length,
    total,
    expectancy: closed.length ? total / closed.length : 0,
    expectancyPct: avgSize ? (total / closed.length / avgSize) * 100 : 0,
    winRate: closed.length ? wins.length / closed.length : 0,
    avgWin: wins.length ? sum(wins) / wins.length : 0,
    avgLoss: losses.length ? sum(losses) / losses.length : 0,
    profitFactor: lossSum > 0 ? sum(wins) / lossSum : wins.length ? Infinity : 0,
    bestShare: total > 0 && wins.length ? Math.max(...wins) / total : null,
    maxDrawdown,
  };

  let verdict: { kind: "wait" | "good" | "bad"; text: string };
  if (metrics.trades < MIN_TRADES) verdict = { kind: "wait", text: `Not enough trades to judge yet (${metrics.trades}/${MIN_TRADES}).` };
  else if (metrics.profitFactor > 1.3 && metrics.expectancy > 0 && (metrics.bestShare ?? 0) < 0.3)
    verdict = { kind: "good", text: "Profitable on paper: worth a tiny live pilot to measure real costs." };
  else verdict = { kind: "bad", text: "Not profitable enough on paper: don't go live; adjust settings and keep testing." };

  return { metrics, verdict, byExit: [...byExit.entries()].sort((a, b) => b[1].n - a[1].n) };
}

/** What signals did afterwards, grouped by decision and skip reason. */
export async function shadowReport(strategy: string) {
  const rows = await db.signal.findMany({
    where: { strategy, OR: [{ ret15: { not: null } }, { ret60: { not: null } }] },
    select: { decision: true, skipReason: true, ret15: true, ret60: true, peakRet: true },
  });
  const groups = new Map<string, { decision: string; reason: string; rows: typeof rows }>();
  for (const r of rows) {
    const reason = r.decision === "TAKEN" ? "taken" : reasonKind(r.skipReason);
    const k = `${r.decision}|${reason}`;
    const g = groups.get(k) ?? { decision: r.decision, reason, rows: [] };
    g.rows.push(r);
    groups.set(k, g);
  }
  const avg = (a: (number | null)[]) => {
    const v = a.filter((x): x is number => x !== null);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  return [...groups.values()]
    .map((g) => ({
      decision: g.decision,
      reason: g.reason,
      n: g.rows.length,
      avg15: avg(g.rows.map((r) => r.ret15)),
      avg60: avg(g.rows.map((r) => r.ret60)),
      hit50: g.rows.filter((r) => (r.peakRet ?? -Infinity) >= 50).length / g.rows.length,
      dead: g.rows.filter((r) => r.ret60 !== null && r.ret60 <= -50).length / Math.max(1, g.rows.filter((r) => r.ret60 !== null).length),
    }))
    .sort((a, b) => (a.decision === "TAKEN" ? -1 : b.decision === "TAKEN" ? 1 : b.n - a.n));
}
