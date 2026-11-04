/**
 * Live prices for open positions: subscribes to each coin's bonding-curve account so every trade
 * pushes a new price immediately (instead of waiting for the 10s poll).
 *
 * Some providers (Infura) only send lamports for program accounts, not the data. The curve is
 * constant-product (vSol × vTok = k, fees are paid outside the curve), so from one full read we
 * know k and the gap between the account's lamports and vSol, and can price every update from
 * lamports alone. When a provider does send the data, it's decoded exactly.
 *
 * Every SOL movement in or out of the curve / pool is also recorded as order flow (in = buy,
 * out = sell), which the momentum-fade exit reads.
 */
import { PublicKey } from "@solana/web3.js";
import { jupSellPrice, pumpSwapPair } from "./market";
import { ata, bondingCurvePda, conn, decodeBondingCurve, poolSolVault, PUMP_DECIMALS, PUMP_PROGRAM } from "./solana";
import { stream } from "./stream";

/* ---------- order flow ---------- */

const flows = new Map<number, { t: number; sol: number }[]>(); // position id → signed SOL moves (+ buy, − sell)

function recordFlow(id: number, sol: number) {
  if (!Number.isFinite(sol) || Math.abs(sol) < 1e-6) return;
  const now = Date.now();
  const f = (flows.get(id) ?? []).filter((x) => now - x.t < 10 * 60_000);
  f.push({ t: now, sol });
  flows.set(id, f);
}

/** Buys and sells (count and SOL) on the coin over the last `windowSec` seconds. */
export function flowStats(id: number, windowSec: number) {
  const since = Date.now() - windowSec * 1000;
  const f = (flows.get(id) ?? []).filter((x) => x.t >= since);
  const buys = f.filter((x) => x.sol > 0);
  const sells = f.filter((x) => x.sol < 0);
  return {
    buys: buys.length,
    sells: sells.length,
    buySol: buys.reduce((s, x) => s + x.sol, 0),
    sellSol: -sells.reduce((s, x) => s + x.sol, 0),
  };
}

type OpenPos = { id: number; mint: string; pool: string | null; remainingTokens: number };

type Calib = { k: number; offset: number; rent: number; at: number };
type Feed = { sub: number; mint: string; calib: Calib };
const feeds = new Map<number, Feed>(); // position id → feed
const noCurve = new Set<number>(); // positions on migrated coins: use a pool feed instead
const poolFeeds = new Map<number, number>(); // position id → stream subscription on the pool's SOL vault
const poolLookedUp = new Set<number>();
const remaining = new Map<number, number>(); // latest token amount per position (for sell quotes)

const priceOf = (vSolLamports: number, vTokRaw: number) => vSolLamports / 1e9 / (vTokRaw / 10 ** PUMP_DECIMALS);

async function open(positionId: number, mint: string, onPrice: (id: number, price: number) => void) {
  const curve = bondingCurvePda(mint);
  const info = await conn().getAccountInfo(curve, "confirmed");
  const bc = info && info.owner.equals(PUMP_PROGRAM) ? decodeBondingCurve(info.data as Buffer) : null;
  if (!info || !bc || bc.complete || !bc.standard) {
    noCurve.add(positionId); // migrated / not a pump curve: the 10s poll handles it
    return;
  }
  const calib = calibrate(info.lamports, bc);
  let prevReal = Number(bc.realSolReserves);
  let prevLamports = info.lamports;

  const stop = () => {
    const f = feeds.get(positionId);
    if (f) stream().unsubscribe(f.sub);
    feeds.delete(positionId);
    noCurve.add(positionId);
  };

  const sub = stream().subscribe(
    "accountSubscribe",
    [curve.toBase58(), { encoding: "jsonParsed", commitment: "confirmed" }],
    (r) => {
      const v = r?.value;
      if (!v) return;
      if (typeof v.lamports === "number") {
        recordFlow(positionId, (v.lamports - prevLamports) / 1e9);
        prevLamports = v.lamports;
      }
      if (Array.isArray(v.data) && v.data[1] === "base64") {
        const full = decodeBondingCurve(Buffer.from(v.data[0], "base64"));
        if (full?.complete) return stop();
        if (full && full.priceSol > 0) onPrice(positionId, full.priceSol);
        return;
      }
      const { k, offset, rent } = calib;
      const real = v.lamports - rent;
      // Graduation drains the curve in one tx: that's a migration to PumpSwap, not a crash.
      if (real < 0.01e9 && prevReal > 50e9) return stop();
      prevReal = real;
      const vSol = v.lamports + offset;
      if (vSol <= 0 || !Number.isFinite(vSol)) return;
      onPrice(positionId, priceOf(vSol, k / vSol));
    },
  );
  feeds.set(positionId, { sub, mint, calib });
}

function calibrate(lamports: number, bc: { virtualSolReserves: bigint; virtualTokenReserves: bigint; realSolReserves: bigint }): Calib {
  return {
    k: Number(bc.virtualSolReserves) * Number(bc.virtualTokenReserves),
    offset: Number(bc.virtualSolReserves) - lamports,
    rent: lamports - Number(bc.realSolReserves),
    at: Date.now(),
  };
}

/** Re-reads the curve so lamport-derived prices can't drift. */
async function recalibrate(f: Feed) {
  const info = await conn().getAccountInfo(bondingCurvePda(f.mint), "confirmed");
  const bc = info ? decodeBondingCurve(info.data as Buffer) : null;
  if (info && bc && !bc.complete) Object.assign(f.calib, calibrate(info.lamports, bc));
}

type PoolFeed = { subs: number[]; mint: string; q: number; b: number; decimals: number; factor: number; calibAt: number };
const poolFeedState = new Map<number, PoolFeed>();

/**
 * PumpSwap coins: subscribes to both pool vaults (SOL and token). Every trade changes them, so the
 * vault ratio gives a live price on each trade. The pool's virtual reserves make the raw ratio differ
 * from the real price, so it's scaled by a factor calibrated against a Jupiter sell quote (what we'd
 * actually get, fees and impact included) every ~20s.
 */
async function openPoolFeed(p: OpenPos, onPrice: (id: number, price: number) => void) {
  let pool = p.pool;
  if (!pool) {
    if (poolLookedUp.has(p.id)) return;
    poolLookedUp.add(p.id);
    pool = (await pumpSwapPair(p.mint))?.pairAddress ?? null;
    if (!pool) return;
  }
  const mintInfo = await conn().getAccountInfo(new PublicKey(p.mint), "confirmed");
  if (!mintInfo) return;
  const quoteVault = poolSolVault(pool);
  const baseVault = ata(pool, p.mint, mintInfo.owner);
  const [qb, bb] = await Promise.all([
    conn().getTokenAccountBalance(quoteVault, "confirmed"),
    conn().getTokenAccountBalance(baseVault, "confirmed"),
  ]);
  const st: PoolFeed = {
    subs: [],
    mint: p.mint,
    q: Number(qb.value.amount),
    b: Number(bb.value.amount),
    decimals: bb.value.decimals,
    factor: 1,
    calibAt: 0,
  };
  poolFeedState.set(p.id, st);
  await calibratePool(p.id, st);

  const emit = () => {
    if (st.q > 0 && st.b > 0) onPrice(p.id, st.factor * ratio(st));
  };
  const amountOf = (r: any) => Number(r?.value?.data?.parsed?.info?.tokenAmount?.amount ?? NaN);
  st.subs.push(
    stream().subscribe("accountSubscribe", [quoteVault.toBase58(), { encoding: "jsonParsed", commitment: "confirmed" }], (r) => {
      const amt = amountOf(r);
      if (!Number.isFinite(amt)) return;
      recordFlow(p.id, (amt - st.q) / 1e9);
      st.q = amt;
      emit();
    }),
    stream().subscribe("accountSubscribe", [baseVault.toBase58(), { encoding: "jsonParsed", commitment: "confirmed" }], (r) => {
      const amt = amountOf(r);
      if (!Number.isFinite(amt)) return;
      st.b = amt;
      emit();
    }),
  );
  poolFeeds.set(p.id, st.subs[0]);
}

const ratio = (st: PoolFeed) => st.q / 1e9 / (st.b / 10 ** st.decimals);

async function calibratePool(id: number, st: PoolFeed) {
  st.calibAt = Date.now();
  const jp = await jupSellPrice(st.mint, remaining.get(id) || 1000).catch(() => null);
  if (jp && st.q > 0 && st.b > 0) st.factor = jp / ratio(st);
}

/** Opens feeds for new open positions and closes feeds for positions that are gone. */
export async function syncPriceFeeds(open_: OpenPos[], onPrice: (id: number, price: number) => void) {
  const want = new Set(open_.map((p) => p.id));
  for (const [id, f] of feeds) {
    if (!want.has(id)) {
      stream().unsubscribe(f.sub);
      feeds.delete(id);
      flows.delete(id);
    }
  }
  for (const [id] of poolFeeds) {
    if (!want.has(id)) {
      for (const sub of poolFeedState.get(id)?.subs ?? []) stream().unsubscribe(sub);
      poolFeeds.delete(id);
      poolFeedState.delete(id);
      flows.delete(id);
    }
  }
  for (const p of open_) {
    remaining.set(p.id, p.remainingTokens);
    const f = feeds.get(p.id);
    if (f) {
      if (Date.now() - f.calib.at > 30_000) await recalibrate(f).catch(() => {});
    } else if (!noCurve.has(p.id)) await open(p.id, p.mint, onPrice).catch(() => {});
    if (noCurve.has(p.id) && !poolFeeds.has(p.id)) await openPoolFeed(p, onPrice).catch(() => {});
    const pf = poolFeedState.get(p.id);
    if (pf && Date.now() - pf.calibAt > 20_000) await calibratePool(p.id, pf);
  }
}

export const liveFeedCount = () => feeds.size + poolFeeds.size;
