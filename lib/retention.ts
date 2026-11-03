/** Keeps the database small: deletes old logs and raw events. Trades and wallet scores are kept. */
import { db } from "./db";

const days = (n: number) => new Date(Date.now() - n * 864e5);

export async function pruneOldData() {
  const [logs, events, signals, tokens] = await Promise.all([
    db.runLog.deleteMany({ where: { createdAt: { lt: days(14) } } }),
    db.walletEvent.deleteMany({ where: { ts: { lt: days(30) } } }),
    db.signal.deleteMany({ where: { createdAt: { lt: days(90) }, positionId: null } }), // keep signals that became trades
    // Graduates that never became winners: no longer needed once they're a few days old.
    db.token.deleteMany({ where: { isWinner: false, studiedAt: null, createdAt: { lt: days(7) } } }),
  ]);
  return { logs: logs.count, events: events.count, signals: signals.count, tokens: tokens.count };
}
