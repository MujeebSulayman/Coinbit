/** Keeps the database small: deletes old logs, raw events and launch history. Trades and wallet scores are kept. */
import { db } from "./db";

const days = (n: number) => new Date(Date.now() - n * 864e5);

export async function pruneOldData() {
  const [logs, events, signals, tokens, points, launches] = await Promise.all([
    db.runLog.deleteMany({ where: { createdAt: { lt: days(14) } } }),
    db.walletEvent.deleteMany({ where: { ts: { lt: days(30) } } }),
    db.signal.deleteMany({ where: { createdAt: { lt: days(90) }, positionId: null } }), // keep signals that became trades
    // Graduates that never became winners: kept 120 days as the dev-reputation history (who graduated what).
    db.token.deleteMany({ where: { isWinner: false, studiedAt: null, createdAt: { lt: days(120) } } }),
    db.launch.deleteMany({ where: { at: { lt: days(10) } } }), // launch history only needs the last 7 days
    db.pricePoint.deleteMany({ where: { ts: { lt: days(60) } } }), // trade-page charts for the last 60 days
  ]);
  return { logs: logs.count, events: events.count, signals: signals.count, tokens: tokens.count, points: points.count, launches: launches.count };
}
