import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../lib/config";
import { historyVerdict, type WalletHistory } from "../lib/history";
import { linkGroups } from "../lib/linked";

test("linked wallets: always-together pairs count once, independent wallets don't merge", () => {
  const fb = (pairs: [string, number][]) => new Map(pairs);
  const buys = new Map([
    ["Bup4", fb([["m1", 100], ["m2", 500], ["m3", 900], ["m4", 2000]])],
    ["Bvka", fb([["m1", 104], ["m2", 503], ["m3", 950], ["m5", 3000]])], // 3 co-buys within 150s
    ["DADD", fb([["m1", 400], ["m2", 2500], ["m6", 10]])], // shares coins, but minutes apart
  ]);
  const g = linkGroups(["Bup4", "Bvka", "DADD"], buys, 150, 3);
  assert.equal(g.length, 2);
  assert.ok(g.some((x) => x.includes("Bup4") && x.includes("Bvka")));
  assert.equal(linkGroups(["Bup4", "Bvka"], buys, 150, 4).length, 2); // stricter: not linked
  assert.equal(linkGroups(["Bup4", "Bvka"], new Map(), 150, 3).length, 2); // no data: independent
  // two busy traders sharing 3 hot coins out of 60 each: not linked (share 5%)
  const busy = (k: string) => new Map(Array.from({ length: 60 }, (_, i) => [`${k}${i}`, i * 1000] as [string, number]).concat([["hot1", 5], ["hot2", 6], ["hot3", 7]]));
  assert.equal(linkGroups(["A", "B"], new Map([["A", busy("a")], ["B", busy("b")]]), 150, 3, 50).length, 2);
});

test("history verdict: followability, insider, one-hit and the evidence bar", () => {
  Object.assign(config, { histMaxTokensPerHour: 10, histMinTokens: 20, histMinWinRate: 0.4, histMinPnlSol: 0, histMinMedianHoldSec: 120, histMaxQuickSellPct: 30, histMaxTopCreatorPct: 30, histMaxBestCoinPct: 70 });
  const good: WalletHistory = { tokens: 30, wins: 15, winRate: 0.5, pnlSol: 5, tokensPerHour: 1, buySizeCv: 0.6, buys: 30, medianHoldSec: 600, quickSellPct: 10, topCreatorPct: 10, bestCoinPct: 30, lastTradeAt: new Date() };
  assert.equal(historyVerdict(good), null);
  assert.match(historyVerdict({ ...good, medianHoldSec: 15 })!, /^can't follow: median hold 15s/);
  assert.match(historyVerdict({ ...good, quickSellPct: 45 })!, /^can't follow: sells within 30s on 45%/);
  assert.match(historyVerdict({ ...good, topCreatorPct: 60 })!, /^insider: 60% of coins from one creator/);
  assert.match(historyVerdict({ ...good, winRate: 0.35 })!, /^history: 35% win rate/);
  assert.match(historyVerdict({ ...good, bestCoinPct: 85 })!, /^one-hit: 85% of profit/);
  assert.equal(historyVerdict({ ...good, tokens: 12, medianHoldSec: 5 }), null); // too little data: not judged (and so not watched)
  assert.equal(historyVerdict({ ...good, medianHoldSec: null, quickSellPct: null, topCreatorPct: null }), null); // unknowns don't fail on their own
});
