/**
 * Pure exit maths (no I/O), shared by the worker and the dashboard and covered by tests.
 *
 * Exit design follows what the better-documented open-source bots converged on (see Kaiser.charon's
 * backtest notes and fdv.lol's sell policies): lock in part of a gain early, react to a sudden quote
 * collapse without waiting for a confirmation tick, and don't sit in a coin that goes nowhere.
 */
export type StopCfg = {
  breakevenAfterTp: boolean;
  breakevenBufferPct: number;
  trailAfterTpPct: number;
  profitLockArmPct: number;
  profitLockKeepPct: number;
};

type PosPrices = { tpHit: number; peakPriceSol: number; entryPriceSol: number };

const gainPct = (price: number, entry: number) => (price / entry - 1) * 100;

/**
 * Stop level as % vs entry, and what kind of stop it is. Starts at the hard stop-loss and only ever
 * moves up:
 *  - profit lock: once the peak gain reaches the arm level, keep `keep`% of the peak gain
 *    (never below break-even + buffer), whether or not a take-profit has hit
 *  - after the first take-profit: break-even + buffer, and a trailing stop below the peak
 */
export function stopLevel(p: PosPrices, stopLossPct: number, cfg: StopCfg) {
  let stopPct = -stopLossPct;
  let stopKind = "stop-loss";
  const raise = (pct: number, kind: string) => {
    if (pct > stopPct) {
      stopPct = pct;
      stopKind = kind;
    }
  };
  const peakGain = gainPct(p.peakPriceSol, p.entryPriceSol);
  if (cfg.profitLockArmPct > 0 && peakGain >= cfg.profitLockArmPct) {
    raise(Math.max(cfg.breakevenBufferPct, (peakGain * cfg.profitLockKeepPct) / 100), "profit lock");
  }
  if (p.tpHit >= 1) {
    if (cfg.breakevenAfterTp) raise(cfg.breakevenBufferPct, "break-even");
    if (cfg.trailAfterTpPct > 0) raise(gainPct(p.peakPriceSol * (1 - cfg.trailAfterTpPct / 100), p.entryPriceSol), "trailing stop");
  }
  return { stopPct, stopKind };
}

/** A position that has gone nowhere: held long enough, never ran, and is still inside the band. */
export function isStagnant(
  p: PosPrices & { heldMin: number; price: number },
  cfg: { stagnantMin: number; stagnantBandPct: number },
) {
  if (cfg.stagnantMin <= 0 || p.tpHit > 0 || p.heldMin < cfg.stagnantMin) return false;
  const peak = gainPct(p.peakPriceSol, p.entryPriceSol);
  const now = gainPct(p.price, p.entryPriceSol);
  return peak < cfg.stagnantBandPct && Math.abs(now) < cfg.stagnantBandPct;
}

/**
 * Quote shock: the price fell `shockPct`% or more from its high within the last `windowSec` seconds.
 * `recent` is the position's recent price readings (oldest first). Returns the drop %, or null.
 */
export function quoteShock(recent: { t: number; p: number }[], now: number, price: number, cfg: { quoteShockPct: number; quoteShockWindowSec: number }) {
  if (cfg.quoteShockPct <= 0) return null;
  const since = now - cfg.quoteShockWindowSec * 1000;
  const high = Math.max(0, ...recent.filter((x) => x.t >= since).map((x) => x.p));
  if (high <= 0) return null;
  const drop = (1 - price / high) * 100;
  return drop >= cfg.quoteShockPct ? drop : null;
}

/** Pump.fun bonding curve (constant product on virtual reserves): tokens out for `solIn` after `feePct`. */
export function curveBuyTokens(vSol: number, vTok: number, solIn: number, feePct: number) {
  const net = solIn * (1 - feePct / 100);
  if (vSol <= 0 || vTok <= 0 || net <= 0) return 0;
  return vTok - (vSol * vTok) / (vSol + net);
}

/**
 * Bad-tick guard for marks: a move of more than `jump`× from the last accepted price is held until the
 * next reading lands within `confirm`× of it. Returns whether to accept `price`, and the pending value.
 */
export function jumpGuard(last: number, price: number, pending: number | null, jump = 3, confirm = 1.5) {
  if (!(last > 0) || (price / last <= jump && last / price <= jump)) return { accept: true, pending: null };
  if (pending && Math.max(price / pending, pending / price) <= confirm) return { accept: true, pending: null };
  return { accept: false, pending: price };
}
