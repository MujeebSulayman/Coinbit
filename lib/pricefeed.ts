/**
 * Live prices for open positions: subscribes to each coin's bonding-curve account so every trade
 * pushes a new price immediately (instead of waiting for the 10s poll).
 *
 * Some providers (Infura) only send lamports for program accounts, not the data. The curve is
 * constant-product (vSol × vTok = k, fees are paid outside the curve), so from one full read we
 * know k and the gap between the account's lamports and vSol, and can price every update from
 * lamports alone. When a provider does send the data, it's decoded exactly.
 */
import { jupSellPrice, pumpSwapPair } from "./market";
import { bondingCurvePda, conn, decodeBondingCurve, poolSolVault, PUMP_DECIMALS, PUMP_PROGRAM } from "./solana";
import { stream } from "./stream";

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
  if (!info || !bc || bc.complete) {
    noCurve.add(positionId); // migrated / not a pump curve: the 10s poll handles it
    return;
  }
  const calib = calibrate(info.lamports, bc);
  let prevReal = Number(bc.realSolReserves);

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

/**
 * PumpSwap coins: any trade changes the pool's SOL vault, so a vault notification triggers a Jupiter
 * sell quote for what we hold (throttled). That's the price we'd actually get, fees and impact included.
 */
async function openPoolFeed(p: OpenPos, onPrice: (id: number, price: number) => void) {
  let pool = p.pool;
  if (!pool) {
    if (poolLookedUp.has(p.id)) return;
    poolLookedUp.add(p.id);
    pool = (await pumpSwapPair(p.mint))?.pairAddress ?? null;
    if (!pool) return;
  }
  let last = 0;
  let pending = false;
  const sub = stream().subscribe(
    "accountSubscribe",
    [poolSolVault(pool).toBase58(), { encoding: "jsonParsed", commitment: "confirmed" }],
    () => {
      if (pending || Date.now() - last < 2500) return;
      pending = true;
      last = Date.now();
      jupSellPrice(p.mint, remaining.get(p.id) ?? p.remainingTokens)
        .then((price) => price && onPrice(p.id, price))
        .catch(() => {})
        .finally(() => (pending = false));
    },
  );
  poolFeeds.set(p.id, sub);
}

/** Opens feeds for new open positions and closes feeds for positions that are gone. */
export async function syncPriceFeeds(open_: OpenPos[], onPrice: (id: number, price: number) => void) {
  const want = new Set(open_.map((p) => p.id));
  for (const [id, f] of feeds) {
    if (!want.has(id)) {
      stream().unsubscribe(f.sub);
      feeds.delete(id);
    }
  }
  for (const [id, sub] of poolFeeds) {
    if (!want.has(id)) {
      stream().unsubscribe(sub);
      poolFeeds.delete(id);
    }
  }
  for (const p of open_) {
    remaining.set(p.id, p.remainingTokens);
    const f = feeds.get(p.id);
    if (f) {
      if (Date.now() - f.calib.at > 30_000) await recalibrate(f).catch(() => {});
    } else if (!noCurve.has(p.id)) await open(p.id, p.mint, onPrice).catch(() => {});
    if (noCurve.has(p.id) && !poolFeeds.has(p.id)) await openPoolFeed(p, onPrice).catch(() => {});
  }
}

export const liveFeedCount = () => feeds.size + poolFeeds.size;
