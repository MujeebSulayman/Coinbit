/**
 * Launch sniper — buys brand-new pump.fun coins moments after they are created.
 *
 * Speed: the PumpPortal create event already carries the creator, the dev's buy and the curve
 * reserves, so the decision makes no network call. Creator history, risk limits and the hourly cap
 * are held in memory and refreshed in the background. A live buy is then one HTTP round-trip to
 * PumpPortal's Local Transaction API, a local signature, and a broadcast on every path (+ Jito).
 *
 * What "fast" means here: PumpPortal relays a create once it is confirmed, so we act a moment after
 * the launch block, not inside it. Same-block sniping needs a Geyser/shred stream and a co-located
 * sender (paid infrastructure). Every live buy logs how many blocks after the launch it landed, so the
 * real latency is measured rather than assumed.
 *
 * Volume: pump.fun sees tens of thousands of launches a day, so skips are counted in memory and
 * summarised in the bot log every 10 minutes instead of being stored one by one. Only buys are
 * recorded as signals (and shadow-tracked like the other strategies).
 */
import { config } from "./config";
import { db, getKv, log } from "./db";
import { prepareBuyFast, readAccountFast, txSlot } from "./executor";
import { curveBuyTokens } from "./exits";
import { solUsd } from "./market";
import { strategyMode } from "./modes";
import { openPosition, todaysPnlSol, watchOpenPositions } from "./positions";
import { type PortalTrade, startPortal } from "./pumpportal";
import { bondingCurvePda, decodeBondingCurve, PUMP_DECIMALS, PUMP_PROGRAM, sleep } from "./solana";

const WEEK_MS = 7 * 864e5;
const PAPER_FEE_PCT = 1.5; // pump.fun curve fee (~1%) + PumpPortal's 0.5% Local API fee

type PortalCreate = PortalTrade & { vSolInBondingCurve?: number; vTokensInBondingCurve?: number; name?: string };

/* ---------- in-memory state, refreshed in the background ---------- */

export const launches7d = new Map<string, number>(); // creator → launches in the last 7 days
export const gradCreators = new Set<string>(); // creators with a graduated coin in our history
export const risk = { paused: false, dailyLossHit: false, openLaunch: 0 };
const boughtAt: number[] = []; // buy times in the last hour
const inFlight = new Set<string>(); // mints with a buy in progress
const skipCounts = new Map<string, number>();
let seenCount = 0;

async function refreshCreators() {
  const since = new Date(Date.now() - WEEK_MS);
  const [rows, grads] = await Promise.all([
    db.launch.groupBy({ by: ["creator"], where: { at: { gte: since } }, _count: true }),
    db.token.findMany({ where: { creator: { not: null } }, select: { creator: true }, distinct: ["creator"] }),
  ]);
  launches7d.clear();
  for (const r of rows) launches7d.set(r.creator, r._count);
  gradCreators.clear();
  for (const g of grads) if (g.creator) gradCreators.add(g.creator);
}

async function refreshRisk() {
  const [paused, open, pnl] = await Promise.all([
    getKv("trading:paused"),
    db.position.count({ where: { status: "OPEN", strategy: "launch" } }),
    todaysPnlSol(),
  ]);
  risk.paused = paused === "true";
  risk.openLaunch = open;
  risk.dailyLossHit = pnl <= -config.dailyLossLimitSol;
}

const skip = (reason: string) => {
  skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
  return null;
};

/** The whole entry decision, synchronous and in memory. Returns a skip reason or null to buy. */
export function decide(m: PortalCreate): string | null {
  const now = Date.now();
  while (boughtAt.length && now - boughtAt[0] > 3600_000) boughtAt.shift();
  const devBuy = m.solAmount ?? 0;
  const creatorLaunches = Math.max(0, (launches7d.get(m.traderPublicKey) ?? 0) - 1); // minus this one

  if (risk.paused) return "trading paused";
  if (risk.dailyLossHit) return "daily loss limit";
  if (risk.openLaunch + inFlight.size >= config.launchMaxOpen) return "max open positions";
  if (boughtAt.length >= config.launchMaxPerHour) return "hourly cap";
  if (inFlight.has(m.mint)) return "already buying";
  if (m.pool && m.pool !== "pump") return `not a pump.fun curve (${m.pool})`;
  if (devBuy < config.launchMinDevBuySol) return "dev buy too small";
  if (devBuy > config.launchMaxDevBuySol) return "dev buy too big";
  if (creatorLaunches > config.launchMaxCreatorLaunches7d) return "serial launcher";
  if (config.launchRequireProvenDev && !gradCreators.has(m.traderPublicKey)) return "dev not proven";
  return null;
}

/**
 * Is this a standard SOL-quoted pump.fun curve? Checked against the launch event: on a constant-product
 * curve vSol × vTok stays fixed as people trade, so it must match the event's. It doesn't for coins
 * quoted in another asset or on non-standard curves (seen in testing: 0.4 to 760 "SOL" against the
 * event's 30), which our SOL maths would misprice. Returns a skip reason, or null if it's tradeable.
 */
export function curveCheck(ev: { vSolInBondingCurve?: number; vTokensInBondingCurve?: number; is_mayhem_mode?: boolean }, curve: { vSol: number; vTok: number; complete: boolean } | null) {
  if (ev.is_mayhem_mode) return "mayhem-mode coin";
  if (!curve) return "curve not readable yet";
  if (curve.complete) return "curve already complete";
  const kEvent = (ev.vSolInBondingCurve ?? 0) * (ev.vTokensInBondingCurve ?? 0);
  const kCurve = curve.vSol * curve.vTok;
  if (!(kEvent > 0) || Math.abs(kCurve / kEvent - 1) > 0.02) return "non-standard curve (not SOL-quoted)";
  return null;
}

/** Reads the coin's bonding curve on the fast connection (one retry: a brand-new account can lag). */
async function readCurve(mint: string) {
  for (let i = 0; i < 2; i++) {
    const info = await readAccountFast(bondingCurvePda(mint)).catch(() => null);
    const bc = info && info.owner.equals(PUMP_PROGRAM) ? decodeBondingCurve(info.data as Buffer) : null;
    if (bc) return { vSol: Number(bc.virtualSolReserves) / 1e9, vTok: Number(bc.virtualTokenReserves) / 10 ** PUMP_DECIMALS, complete: bc.complete };
    await sleep(400);
  }
  return null;
}

async function onCreate(m: PortalCreate) {
  const t0 = Date.now();
  if (m.traderPublicKey) launches7d.set(m.traderPublicKey, (launches7d.get(m.traderPublicKey) ?? 0) + 1);
  const mode = await strategyMode("launch"); // cached in memory
  if (mode === "off") return;
  seenCount++;
  const reason = decide(m);
  if (reason) return skip(reason);

  inFlight.add(m.mint);
  boughtAt.push(t0);
  const size = config.launchSizeSol;
  const devBuy = m.solAmount ?? 0;
  try {
    // Live: PumpPortal starts building the buy now, while we read the curve; it's only sent if the check passes.
    const prepared = mode === "live" ? prepareBuyFast(m.mint, size) : null;
    const curve = await readCurve(m.mint);
    const bad = curveCheck(m, curve);
    if (bad) {
      boughtAt.pop();
      return skip(bad);
    }
    // Paper: fill at the curve as it is now (that read takes about as long as a live buy needs to land,
    // so earlier buyers are priced in), after the curve fee and PumpPortal's 0.5%.
    const paperTokens = mode === "paper" ? curveBuyTokens(curve!.vSol, curve!.vTok, size, PAPER_FEE_PCT) : undefined;
    let landedSlot: number | null = null;
    const pos = await openPosition({
      strategy: "launch",
      mode: mode === "live" ? "live" : "paper",
      mint: m.mint,
      symbol: m.symbol ?? null,
      priceSol: (m.vSolInBondingCurve ?? 0) / Math.max(1, m.vTokensInBondingCurve ?? 0),
      sizeSol: size,
      triggerWallets: [],
      sendLive: prepared?.send,
      paperTokens,
      onFill: (f) => (landedSlot = f.slot ?? null),
    });
    const sentMs = Date.now() - t0;
    if (!pos) return;
    risk.openLaunch++;
    watchOpenPositions().catch(() => {});

    // Latency: for live buys, blocks between the launch tx and ours.
    let blocks: number | null = null;
    if (landedSlot !== null) {
      const created = await txSlot(m.signature);
      if (created !== null) blocks = landedSlot - created;
    }
    const creatorLaunches = Math.max(0, (launches7d.get(m.traderPublicKey) ?? 1) - 1);
    const parts = [
      `dev bought ${devBuy.toFixed(2)} SOL`,
      `creator: ${creatorLaunches} other launch${creatorLaunches === 1 ? "" : "es"} in 7d${gradCreators.has(m.traderPublicKey) ? ", graduated before" : ""}`,
      mode === "live"
        ? `landed ${blocks ?? "?"} block${blocks === 1 ? "" : "s"} after launch (${sentMs}ms from event)`
        : `paper fill at the live curve (${sentMs}ms from event)`,
    ];
    const sol = await solUsd();
    await db.signal.create({
      data: {
        strategy: "launch",
        mint: m.mint,
        symbol: m.symbol ?? null,
        reason: parts.join(" · "),
        wallets: [m.traderPublicKey],
        confluence: 0,
        mcapUsd: m.marketCapSol ? m.marketCapSol * sol : undefined,
        ageMin: 0,
        curvePct: 0,
        priceSol: pos.entryPriceSol,
        decision: "TAKEN",
        positionId: pos.id,
      },
    });
    await log("signal", `launch ${m.symbol ?? m.mint}: ${parts.join(" · ")} → TAKE (${mode})`);
  } catch (e) {
    await log("trade", `launch buy failed ${m.symbol ?? m.mint}: ${(e as Error).message}`);
  } finally {
    inFlight.delete(m.mint);
  }
}

async function summarise() {
  if (!seenCount) return;
  const skipped = [...skipCounts].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`);
  const bought = seenCount - [...skipCounts.values()].reduce((s, n) => s + n, 0);
  await log("signal", `launch sniper, last 10m: ${seenCount} launches, ${bought} bought${skipped.length ? ` · skipped: ${skipped.join(", ")}` : ""}`);
  seenCount = 0;
  skipCounts.clear();
}

export function startLaunchStrategy() {
  refreshCreators().catch((e) => log("signal", `launch sniper: creator history load failed: ${(e as Error).message}`));
  refreshRisk().catch(() => {});
  setInterval(() => refreshCreators().catch(() => {}), 10 * 60_000);
  setInterval(() => refreshRisk().catch(() => {}), 2000);
  setInterval(() => summarise().catch(() => {}), 10 * 60_000);
  startPortal({ onCreate: (m) => void onCreate(m as PortalCreate).catch(() => {}) });
}
