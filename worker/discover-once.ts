/** Run a single discovery pass from the CLI:  npm run discover */
import "dotenv/config";
import { db } from "../lib/db";
import { runDiscovery } from "../lib/discovery";

runDiscovery()
  .then(async () => {
    const top = await db.wallet.findMany({ where: { status: "WATCHING" }, orderBy: { score: "desc" }, take: 20 });
    console.table(
      top.map((w) => ({ wallet: w.address, kind: w.kind, score: w.score.toFixed(1), winners: w.winners, launches: w.launchWinners, avgRank: w.avgEntryRank.toFixed(1) })),
    );
  })
  .finally(() => db.$disconnect());
