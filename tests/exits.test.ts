import assert from "node:assert/strict";
import { test } from "node:test";
import { curveBuyTokens, isStagnant, quoteShock, stopLevel, type StopCfg } from "../lib/exits";

const cfg: StopCfg = { breakevenAfterTp: true, breakevenBufferPct: 2, trailAfterTpPct: 50, profitLockArmPct: 10, profitLockKeepPct: 55 };
const pos = (peakGain: number, tpHit = 0) => ({ tpHit, entryPriceSol: 1, peakPriceSol: 1 + peakGain / 100 });

test("stop-loss applies until the profit lock arms", () => {
  assert.deepEqual(stopLevel(pos(0), 25, cfg), { stopPct: -25, stopKind: "stop-loss" });
  assert.deepEqual(stopLevel(pos(9.9), 25, cfg), { stopPct: -25, stopKind: "stop-loss" });
});

test("profit lock keeps 55% of the peak gain, never below break-even + buffer", () => {
  const a = stopLevel(pos(20), 25, cfg);
  assert.equal(a.stopKind, "profit lock");
  assert.ok(Math.abs(a.stopPct - 11) < 1e-9); // 55% of +20%
  const b = stopLevel(pos(10), 25, cfg);
  assert.ok(Math.abs(b.stopPct - 5.5) < 1e-9);
  const low = stopLevel(pos(3), 25, { ...cfg, profitLockArmPct: 3 }); // 55% of 3 = 1.65 < buffer 2
  assert.equal(low.stopPct, 2);
});

test("profit lock off when arm is 0", () => {
  assert.equal(stopLevel(pos(50), 25, { ...cfg, profitLockArmPct: 0 }).stopKind, "stop-loss");
});

test("after a take-profit the highest of lock, break-even and trail wins", () => {
  // peak +200%: trail 50% below peak = +50%; lock = 110% → lock wins
  const s = stopLevel(pos(200, 1), 25, cfg);
  assert.equal(s.stopKind, "profit lock");
  assert.ok(Math.abs(s.stopPct - 110) < 1e-9);
  // lock off: trailing stop at +50%
  const t = stopLevel(pos(200, 1), 25, { ...cfg, profitLockArmPct: 0 });
  assert.equal(t.stopKind, "trailing stop");
  assert.ok(Math.abs(t.stopPct - 50) < 1e-9);
});

test("stagnation: held long enough, never ran, still inside the band", () => {
  const c = { stagnantMin: 10, stagnantBandPct: 10 };
  const base = { tpHit: 0, entryPriceSol: 1, peakPriceSol: 1.05, heldMin: 11, price: 0.97 };
  assert.equal(isStagnant(base, c), true);
  assert.equal(isStagnant({ ...base, heldMin: 9 }, c), false); // too early
  assert.equal(isStagnant({ ...base, peakPriceSol: 1.15 }, c), false); // it ran once
  assert.equal(isStagnant({ ...base, price: 0.85 }, c), false); // falling: the stop handles it
  assert.equal(isStagnant({ ...base, tpHit: 1 }, c), false);
  assert.equal(isStagnant(base, { ...c, stagnantMin: 0 }), false); // off
});

test("quote shock: drop from the high inside the window only", () => {
  const c = { quoteShockPct: 20, quoteShockWindowSec: 10 };
  const now = 100_000;
  const recent = [
    { t: now - 30_000, p: 2 }, // outside the window: ignored
    { t: now - 8_000, p: 1.0 },
    { t: now - 3_000, p: 0.95 },
  ];
  assert.equal(quoteShock(recent, now, 0.85, c), null); // −15% from 1.0
  const d = quoteShock(recent, now, 0.75, c);
  assert.ok(d !== null && Math.abs(d - 25) < 1e-9);
  assert.equal(quoteShock([], now, 0.5, c), null);
  assert.equal(quoteShock(recent, now, 0.1, { ...c, quoteShockPct: 0 }), null);
});

test("curve buy matches constant product after fees", () => {
  // Real launch event: 30.05 SOL / 1,071,211,616 tokens virtual reserves
  const vSol = 30.050084893776955, vTok = 1071211616;
  const t = curveBuyTokens(vSol, vTok, 0.05, 1.5);
  const net = 0.05 * 0.985;
  assert.ok(Math.abs(t - (vTok - (vSol * vTok) / (vSol + net))) < 1e-6);
  // ≈ price × size for a small buy (impact ~0.16%)
  assert.ok(t < (net / vSol) * vTok && t > (net / vSol) * vTok * 0.99);
  assert.equal(curveBuyTokens(0, vTok, 1, 1), 0);
});

test("jump guard: a >3× tick is held until the next reading confirms it", async () => {
  const { jumpGuard } = await import("../lib/exits");
  assert.deepEqual(jumpGuard(1, 1.5, null), { accept: true, pending: null }); // normal move
  const a = jumpGuard(1, 21, null); // #52-style bad tick
  assert.equal(a.accept, false);
  assert.equal(jumpGuard(1, 1.1, a.pending).accept, true); // next reading back to normal: bad tick dropped
  const b = jumpGuard(1, 0.2, null); // −80% in one reading
  assert.equal(b.accept, false);
  assert.equal(jumpGuard(1, 0.21, b.pending).accept, true); // confirmed collapse: acted on one reading later
  assert.equal(jumpGuard(1, 5, jumpGuard(1, 21, null).pending).accept, false); // 21 then 5: not confirmed
});
