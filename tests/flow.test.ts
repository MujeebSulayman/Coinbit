import assert from "node:assert/strict";
import { test } from "node:test";
import { CurveFlow, type FlowCfg } from "../lib/flow";

const cfg: FlowCfg = { flowBlocks: 10, minInflowSol: 5, minBuyBlocks: 4, maxCurveSol: 85, requireDevSold: false };
const K_V = 30, K_T = 1_073_000_000; // a fresh standard curve

test("no trades: no signal", () => {
  const f = new CurveFlow(K_V, K_T, 100);
  const s = f.signal(cfg);
  assert.equal(s.fire, false);
  assert.equal(s.why, "inflow");
});

test("steady buying over the window fires, with price ∝ vSol²", () => {
  const f = new CurveFlow(K_V, K_T, 100);
  for (let i = 1; i <= 6; i++) f.update(100 + i, K_V + i); // +1 SOL per block for 6 blocks
  const s = f.signal(cfg);
  assert.equal(s.fire, true);
  assert.equal(s.inflowSol, 6);
  assert.equal(s.buyBlocks, 6);
  assert.ok(Math.abs(s.risePct - ((36 / 30) ** 2 - 1) * 100) < 1e-9); // +44%
  assert.ok(Math.abs(f.price - (36 * 36) / (K_V * K_T)) < 1e-18);
});

test("one big buy is not breadth", () => {
  const f = new CurveFlow(K_V, K_T, 100);
  f.update(101, 40); // a single 10 SOL buy
  const s = f.signal(cfg);
  assert.equal(s.fire, false);
  assert.equal(s.why, "breadth");
});

test("only the last N blocks count; older inflow drops out", () => {
  const f = new CurveFlow(K_V, K_T, 100);
  for (let i = 1; i <= 6; i++) f.update(100 + i, K_V + i); // 36 SOL by block 106
  f.update(130, 36); // nothing since: window 120..130 has no change
  assert.equal(f.signal(cfg).fire, false);
});

test("sells count against inflow", () => {
  const f = new CurveFlow(K_V, K_T, 100);
  for (let i = 1; i <= 6; i++) f.update(100 + i, K_V + i); // +6
  f.update(107, 33); // −3 sold
  const s = f.signal(cfg);
  assert.equal(s.inflowSol, 3);
  assert.equal(s.fire, false);
});

test("several changes in one block keep the last state", () => {
  const f = new CurveFlow(K_V, K_T, 100);
  f.update(101, 31);
  f.update(101, 32);
  assert.equal(f.vSol, 32);
  f.update(99, 50); // out of order: ignored
  assert.equal(f.vSol, 32);
});

test("curve cap and dev-sold requirement", () => {
  const f = new CurveFlow(80, (K_V * K_T) / 80, 100);
  for (let i = 1; i <= 6; i++) f.update(100 + i, 80 + i); // ends at 86 > 85
  assert.equal(f.signal(cfg).why, "curve too far along");
  const g = new CurveFlow(K_V, K_T, 100);
  for (let i = 1; i <= 6; i++) g.update(100 + i, K_V + i);
  assert.equal(g.signal({ ...cfg, requireDevSold: true }).why, "dev hasn't sold");
  g.devSold = true;
  assert.equal(g.signal({ ...cfg, requireDevSold: true }).fire, true);
});
