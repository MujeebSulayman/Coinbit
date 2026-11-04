import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../lib/config";
import { decide, gradCreators, launches7d, risk } from "../lib/launch";

const ev = (o: Record<string, unknown> = {}) =>
  ({ signature: "sig", mint: `mint${Math.random()}`, traderPublicKey: "dev1", txType: "create", solAmount: 0.5, pool: "pump", ...o }) as never;

test("sniper entry rules", () => {
  Object.assign(config, { launchMaxOpen: 3, launchMaxPerHour: 20, launchMinDevBuySol: 0, launchMaxDevBuySol: 5, launchMaxCreatorLaunches7d: 3, launchRequireProvenDev: false });
  Object.assign(risk, { paused: false, dailyLossHit: false, openLaunch: 0 });
  launches7d.clear();
  gradCreators.clear();

  launches7d.set("dev1", 1); // this launch only
  assert.equal(decide(ev()), null);
  assert.equal(decide(ev({ solAmount: 6 })), "dev buy too big");
  assert.equal(decide(ev({ pool: "bonk" })), "not a pump.fun curve (bonk)");

  launches7d.set("dev1", 5); // 4 others in 7d > 3
  assert.equal(decide(ev()), "serial launcher");
  launches7d.set("dev1", 4); // 3 others: allowed
  assert.equal(decide(ev()), null);

  config.launchRequireProvenDev = true;
  assert.equal(decide(ev()), "dev not proven");
  gradCreators.add("dev1");
  assert.equal(decide(ev()), null);
  config.launchRequireProvenDev = false;

  risk.openLaunch = 3;
  assert.equal(decide(ev()), "max open positions");
  risk.openLaunch = 0;
  risk.paused = true;
  assert.equal(decide(ev()), "trading paused");
  risk.paused = false;
  risk.dailyLossHit = true;
  assert.equal(decide(ev()), "daily loss limit");
});

test("curve check uses vSol × vTok from real launches (2026-11-04)", async () => {
  const { curveCheck } = await import("../lib/launch");
  // DCAT: standard SOL curve, reserves identical
  assert.equal(curveCheck({ vSolInBondingCurve: 30.148148147, vTokensInBondingCurve: 1067727272.767936 }, { vSol: 30.148148147, vTok: 1067727272.767936, complete: false }), null);
  // standard curve after someone else bought: vSol up, vTok down, k unchanged → still fine
  assert.equal(curveCheck({ vSolInBondingCurve: 30, vTokensInBondingCurve: 1073000000 }, { vSol: 32, vTok: (30 * 1073000000) / 32, complete: false }), null);
  // TOGETHER / tremp: event says 30 SOL, curve holds a different quote asset
  assert.equal(curveCheck({ vSolInBondingCurve: 30, vTokensInBondingCurve: 1073000000 }, { vSol: 760.854059297, vTok: 1073000000, complete: false }), "non-standard curve (not SOL-quoted)");
  assert.equal(curveCheck({ vSolInBondingCurve: 30, vTokensInBondingCurve: 1073000000 }, { vSol: 0.614415902, vTok: 1073000000, complete: false }), "non-standard curve (not SOL-quoted)");
  // $COBRA: mayhem mode
  assert.equal(curveCheck({ vSolInBondingCurve: 30.03, vTokensInBondingCurve: 1071766851, is_mayhem_mode: true }, { vSol: 4.29, vTok: 1071766851, complete: false }), "mayhem-mode coin");
  assert.equal(curveCheck({ vSolInBondingCurve: 30, vTokensInBondingCurve: 1073000000 }, null), "curve not readable yet");
});

test("decodeBondingCurve flags curves that aren't SOL-quoted (2026-11 fake-gain bug)", async () => {
  const { decodeBondingCurve } = await import("../lib/solana");
  const buf = (vSolLamports: bigint, vTokRaw: bigint, complete = false) => {
    const b = Buffer.alloc(81);
    b.writeBigUInt64LE(vTokRaw, 8);
    b.writeBigUInt64LE(vSolLamports, 16);
    b.writeBigUInt64LE(793_100_000_000_000n, 24);
    b.writeBigUInt64LE(0n, 32);
    b.writeBigUInt64LE(1_000_000_000_000_000n, 40);
    b[48] = complete ? 1 : 0;
    return b;
  };
  assert.equal(decodeBondingCurve(buf(30_000_000_000n, 1_073_000_000_000_000n))!.standard, true); // fresh
  assert.equal(decodeBondingCurve(buf(32_000_000_000n, 1_005_937_500_000_000n))!.standard, true); // after buys, same k
  assert.equal(decodeBondingCurve(buf(760_854_059_297n, 1_073_000_000_000_000n))!.standard, false); // ~25× k
  assert.equal(decodeBondingCurve(buf(0n, 0n, true))!.standard, true); // completed: priced elsewhere
});
