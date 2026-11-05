/**
 * Linked wallets: count wallets that act as one as a single decision.
 *
 * Copy trading buys when 2+ watched wallets buy the same coin. But Bup4…+Bvka… bought together on all
 * 13 of their signals: likely one operator, so "2 wallets" was really one opinion. Argos groups wallets
 * the same way (buys of the same coin within 150s, on at least 2 different launches); we also require
 * that co-buys are most of the smaller wallet's coins. Uses the listener's buys over the last 7 days.
 */
import { config } from "./config";
import { db } from "./db";

/** Pure: groups wallets whose first buys of the same coin keep landing within `windowSec`. */
export function linkGroups(
  wallets: string[],
  firstBuys: Map<string, Map<string, number>>, // wallet → mint → first buy time (s)
  windowSec: number,
  minCoBuys: number,
  minSharePct = 50,
): string[][] {
  const parent = new Map(wallets.map((w) => [w, w]));
  const find = (w: string): string => (parent.get(w) === w ? w : find(parent.get(w)!));
  for (let i = 0; i < wallets.length; i++)
    for (let j = i + 1; j < wallets.length; j++) {
      const a = firstBuys.get(wallets[i]), b = firstBuys.get(wallets[j]);
      if (!a || !b) continue;
      let co = 0;
      for (const [mint, ta] of a) {
        const tb = b.get(mint);
        if (tb !== undefined && Math.abs(ta - tb) <= windowSec) co++;
      }
      // Both a count and a share: active traders all buy the same hot coins, so a few shared coins mean
      // nothing (a count-only rule chained 78 of 150 wallets into one group). Linked wallets buy together
      // on most of their coins (7djZ/YARS/Czsx: 69 of 75 coins, in the same block).
      if (co >= minCoBuys && (co / Math.min(a.size, b.size)) * 100 >= minSharePct) parent.set(find(wallets[i]), find(wallets[j]));
    }
  const groups = new Map<string, string[]>();
  for (const w of wallets) groups.set(find(w), [...(groups.get(find(w)) ?? []), w]);
  return [...groups.values()];
}

/** Independent groups among `wallets` (each group is one decision). */
export async function independentGroups(wallets: string[]): Promise<string[][]> {
  if (wallets.length < 2) return wallets.map((w) => [w]);
  const events = await db.walletEvent.findMany({
    where: { wallet: { in: wallets }, side: { in: ["BUY", "CREATE"] }, ts: { gte: new Date(Date.now() - 7 * 864e5) } },
    select: { wallet: true, mint: true, ts: true },
  });
  const firstBuys = new Map<string, Map<string, number>>();
  for (const e of events) {
    const m = firstBuys.get(e.wallet) ?? new Map<string, number>();
    const t = e.ts.getTime() / 1000;
    if (!m.has(e.mint) || t < m.get(e.mint)!) m.set(e.mint, t);
    firstBuys.set(e.wallet, m);
  }
  return linkGroups(wallets, firstBuys, config.copyLinkWindowSec, config.copyLinkMinCoBuys, config.copyLinkMinSharePct);
}
