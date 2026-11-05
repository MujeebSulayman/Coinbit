import "dotenv/config";
import { appendFileSync, writeFileSync } from "node:fs";
import { db } from "./lib/db";
import { historyVerdict, walletHistory } from "./lib/history";
// Read-only calibration: new history metrics + verdicts for 20 watched wallets. No DB writes.
const OUT = "/private/tmp/claude-501/-Users-user-Documents-Coinbit/1c936b4a-3260-4cc7-9d52-4e8cfbced68d/scratchpad/calib.jsonl"; writeFileSync(OUT, "");
(async () => {
  const ws = await db.wallet.findMany({ where: { status: "WATCHING", kind: "TRADER" }, orderBy: { score: "desc" }, take: 20, select: { address: true, histWinRate: true, histTokens: true } });
  for (const w of ws) {
    try {
      const h = await walletHistory(w.address);
      appendFileSync(OUT, JSON.stringify({ w: w.address.slice(0, 4), tokens: h.tokens, winRate: +(h.winRate * 100).toFixed(0), pnl: +h.pnlSol.toFixed(2), medianHoldSec: h.medianHoldSec, quickSellPct: h.quickSellPct && +h.quickSellPct.toFixed(0), topCreatorPct: h.topCreatorPct && +h.topCreatorPct.toFixed(0), bestCoinPct: h.bestCoinPct && +h.bestCoinPct.toFixed(0), idleH: h.lastTradeAt ? +((Date.now() - h.lastTradeAt.getTime()) / 3600e3).toFixed(1) : null, verdict: historyVerdict(h) ?? (h.tokens < 20 ? "not judged (<20 coins): not watched" : "KEEP") }) + "\n");
    } catch (e) { appendFileSync(OUT, JSON.stringify({ w: w.address.slice(0, 4), error: (e as Error).message }) + "\n"); }
  }
  appendFileSync(OUT, JSON.stringify({ done: true }) + "\n");
  await db.$disconnect();
})();
