import { config } from "./config";
import { db, getKv } from "./db";

export async function getStats() {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const [closed, open, watching, candidates, excluded, launchers, signals24, taken24, paused, hb, lastDisc] =
    await Promise.all([
      db.position.findMany({ where: { status: "CLOSED" }, select: { realizedSol: true, sizeSol: true, closedAt: true } }),
      db.position.findMany({ where: { status: "OPEN" } }),
      db.wallet.count({ where: { status: "WATCHING" } }),
      db.wallet.count({ where: { status: "CANDIDATE" } }),
      db.wallet.count({ where: { status: "EXCLUDED" } }),
      db.wallet.count({ where: { status: "WATCHING", kind: "LAUNCHER" } }),
      db.signal.count({ where: { createdAt: { gte: new Date(Date.now() - 864e5) } } }),
      db.signal.count({ where: { createdAt: { gte: new Date(Date.now() - 864e5) }, decision: "TAKEN" } }),
      getKv("trading:paused"),
      getKv("worker:heartbeat"),
      getKv("discovery:lastRun"),
    ]);
  const pnl = (p: { realizedSol: number; sizeSol: number }) => p.realizedSol - p.sizeSol;
  const realized = closed.reduce((s, p) => s + pnl(p), 0);
  const today = closed.filter((p) => p.closedAt && p.closedAt >= dayStart).reduce((s, p) => s + pnl(p), 0);
  const wins = closed.filter((p) => pnl(p) > 0).length;
  const unrealized = open.reduce((s, p) => s + p.realizedSol + p.remainingTokens * p.currentPriceSol - p.sizeSol, 0);
  const heartbeat = hb ? (JSON.parse(hb) as { at: string; watching: number; mode: string }) : null;
  return {
    mode: config.mode,
    paused: paused === "true",
    workerOnline: !!heartbeat && Date.now() - new Date(heartbeat.at).getTime() < 90_000,
    heartbeat,
    lastDiscovery: lastDisc,
    realized,
    today,
    unrealized,
    trades: closed.length,
    winRate: closed.length ? wins / closed.length : 0,
    openCount: open.length,
    watching,
    candidates,
    excluded,
    launchers,
    signals24,
    taken24,
  };
}
