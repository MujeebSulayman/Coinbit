/**
 * Order flow on a brand-new coin's bonding curve, for the launch sniper's "drafter" entry: instead of
 * racing for the launch block, wait for demand to show up and buy into it.
 *
 * Source of the idea: D3AD-E/Solana-sniper-bot's on-chain study of wallet 57stAMF… ("the drafter",
 * Aug 2026): never bought in the launch block, entered a median 46 blocks after launch, and only when
 * money was flowing in (>5 SOL per 10 blocks), many wallets were buying, and the price was rising.
 * One developer's study of one wallet, so these thresholds are a starting point to tune, not a law.
 *
 * Pure state, no I/O. Fed with the curve's virtual SOL reserve after each change (from an account
 * subscription). The curve is constant product (vSol × vTok = k), so vSol alone gives the price
 * (vSol² / k) and its change is the net SOL bought (+) or sold (−).
 */
export type FlowCfg = {
  flowBlocks: number; // window, in blocks (slots)
  minInflowSol: number; // net SOL into the curve within the window
  minBuyBlocks: number; // blocks in the window where the curve gained SOL
  maxCurveSol: number; // don't buy once the curve's virtual SOL is past this (it completes near 115)
  requireDevSold: boolean;
};

export type FlowSignal = { fire: boolean; inflowSol: number; buyBlocks: number; risePct: number; vSol: number; why: string };

export class CurveFlow {
  readonly k: number;
  private points: { slot: number; vSol: number }[] = [];
  devSold = false;

  constructor(vSol0: number, vTok0: number, slot0 = 0) {
    this.k = vSol0 * vTok0;
    this.points.push({ slot: slot0, vSol: vSol0 });
  }

  /** Records the curve's state after a change. Several changes in one block keep the last. */
  update(slot: number, vSol: number) {
    const last = this.points[this.points.length - 1];
    if (slot < last.slot) return;
    if (slot === last.slot) last.vSol = vSol;
    else this.points.push({ slot, vSol });
    // Keep a bounded history (plenty for any sane window).
    if (this.points.length > 400) this.points.splice(0, this.points.length - 400);
  }

  get vSol() {
    return this.points[this.points.length - 1].vSol;
  }
  get vTok() {
    return this.k / this.vSol;
  }
  get slot() {
    return this.points[this.points.length - 1].slot;
  }
  get price() {
    return this.vSol / this.vTok;
  }

  /** Flow over the last `flowBlocks` blocks, and whether it meets the entry rule. */
  signal(cfg: FlowCfg): FlowSignal {
    const now = this.points[this.points.length - 1];
    const from = now.slot - cfg.flowBlocks;
    // Baseline: the last state at or before the window start (or the first state we have).
    let baseIdx = 0;
    for (let i = this.points.length - 1; i >= 0; i--) {
      if (this.points[i].slot <= from) {
        baseIdx = i;
        break;
      }
    }
    const base = this.points[baseIdx];
    let buyBlocks = 0;
    for (let i = baseIdx + 1; i < this.points.length; i++) if (this.points[i].vSol > this.points[i - 1].vSol) buyBlocks++;
    const inflowSol = now.vSol - base.vSol;
    const risePct = ((now.vSol / base.vSol) ** 2 - 1) * 100; // price ∝ vSol²
    const why =
      inflowSol < cfg.minInflowSol
        ? "inflow"
        : buyBlocks < cfg.minBuyBlocks
          ? "breadth"
          : now.vSol > cfg.maxCurveSol
            ? "curve too far along"
            : cfg.requireDevSold && !this.devSold
              ? "dev hasn't sold"
              : "";
    return { fire: !why, inflowSol, buyBlocks, risePct, vSol: now.vSol, why };
  }
}
