/** Strategy evaluation: the numbers that say whether a strategy is worth real money. */
import { db } from "./db";
import { FACTORY_GRADS } from "./devrep";

export const MIN_TRADES = 50;

/** "stop-loss -26%" → "stop-loss", "mirror exit (2/3 wallets sold)" → "mirror exit". */
const exitKind = (r: string | null) =>
  (r ?? "unknown")
    .split(/[:(]/)[0] // "insider dump: …", "momentum faded (…)", "mirror exit (…)" → just the name
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

/**
 * Research filters under test (social links, dev reputation): how every graduate did afterwards,
 * grouped by each feature, before either filter is allowed to block trades. Median matters more than
 * the average here: a few 10× coins drag averages up while most graduates die.
 */
export async function filterTest() {
  const rows = await db.signal.findMany({
    where: { strategy: "migration", ret60: { not: null }, OR: [{ socials: { not: null } }, { devGrads: { not: null } }] },
    select: { socials: true, devGrads: true, devRecent: true, ret60: true, peakRet: true, decision: true },
  });
  const summarize = (label: string, rs: typeof rows) => {
    const r = rs.map((x) => x.ret60!).sort((a, b) => a - b);
    return {
      label,
      n: rs.length,
      median: r.length ? r[Math.floor(r.length / 2)] : null,
      avg: r.length ? r.reduce((s, x) => s + x, 0) / r.length : null,
      hit30: rs.length ? rs.filter((x) => (x.peakRet ?? -Infinity) >= 30).length / rs.length : 0,
      dead: rs.length ? rs.filter((x) => x.ret60! <= -50).length / rs.length : 0,
      taken: rs.filter((x) => x.decision === "TAKEN").length,
    };
  };
  const withSocials = rows.filter((x) => x.socials !== null);
  const socials = [0, 1, 2, 3].map((k) => summarize(`${k} of 3`, withSocials.filter((x) => x.socials === k)));
  const withDev = rows.filter((x) => x.devGrads !== null);
  const dev = [
    summarize("Proven: graduated before, quiet 7d", withDev.filter((x) => x.devGrads! > 0 && x.devGrads! < FACTORY_GRADS && x.devRecent === 0)),
    summarize("Graduated before, still launching", withDev.filter((x) => x.devGrads! > 0 && x.devGrads! < FACTORY_GRADS && x.devRecent! > 0)),
    summarize(`Graduation factory: ${FACTORY_GRADS}+ graduates`, withDev.filter((x) => x.devGrads! >= FACTORY_GRADS)),
    summarize("First graduate, quiet 7d", withDev.filter((x) => x.devGrads === 0 && x.devRecent === 0)),
    summarize("First graduate, serial launcher", withDev.filter((x) => x.devGrads === 0 && x.devRecent! > 0)),
  ];
  const oldest = await db.launch.findFirst({ orderBy: { at: "asc" }, select: { at: true } });
  const coverageDays = oldest ? (Date.now() - oldest.at.getTime()) / 864e5 : 0;
  return { socials, dev, all: summarize("All graduates", rows), coverageDays };
}
