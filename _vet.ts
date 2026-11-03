import "dotenv/config";
import { db } from "./lib/db";
import { refreshWatchlist } from "./lib/discovery";
(async () => {
  const t0 = Date.now();
  const r = await refreshWatchlist(60);
  console.log(`vetted ${r.vetted}, watchlist ${r.before} → ${r.after} (${Math.round((Date.now() - t0) / 1000)}s)`);
  const w = await db.wallet.findMany({ where: { status: "WATCHING" }, select: { address: true, winners: true, histTokens: true, histWinRate: true, histPnlSol: true } });
  for (const x of w) console.log(`  ${x.address.slice(0, 6)}… winners ${x.winners} | ${x.histTokens ?? "?"} coins, ${((x.histWinRate ?? 0) * 100).toFixed(0)}% win, ${(x.histPnlSol ?? 0).toFixed(2)} SOL`);
  const reasons = await db.wallet.groupBy({ by: ["excludeReason"], where: { status: "EXCLUDED" }, _count: true });
  const agg = new Map<string, number>();
  for (const r of reasons) { const k = (r.excludeReason ?? "?").replace(/[\d.]+/g, "N"); agg.set(k, (agg.get(k) ?? 0) + r._count); }
  console.log("excluded by reason:", JSON.stringify([...agg]));
  process.exit(0);
})();
