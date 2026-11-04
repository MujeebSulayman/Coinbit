/**
 * Launch sniper, "drafter" style: watch brand-new pump.fun coins and buy only into real demand, then
 * sell on a ladder within ~10 seconds.
 *
 * Why not race for the launch block: on-chain studies (Bitquery: 8.2M launches; D3AD-E's wallet
 * teardowns, Aug 2026) show blind early buys lose, creator dumps cause most losses, and the launch-block
 * race needs ShredStream, co-location and ~0.1 SOL fees per attempt. A wallet that entered a median 46
 * blocks (~18s) after launch, only when money was flowing in, did as well with no race and near-zero
 * fees. Free data is enough for that: the PumpPortal create feed + Helius account subscriptions.
 *
 * Per launch:
 *  1. In-memory prefilters (risk limits, serial launchers, dev bag size): no network call.
 *  2. One curve read: only standard SOL-quoted curves (see curveCheck).
 *  3. Watch for up to LAUNCH_WATCH_SEC: the bonding curve (every trade changes its SOL reserve) and
 *     the creator's token account (a drop = the creator sold). See lib/flow.ts for the entry rule.
 *  4. On a trigger: buy (live via PumpPortal's Local Transaction API; paper at the curve a moment later,
 *     about when a live buy would land). The position then sells on a block-timed ladder
 *     (scheduleSellLadder), and at once if the creator sells.
 *
 * Volume: pump.fun sees tens of thousands of launches a day, so skips are counted in memory and
 * summarised in the bot log every 10 minutes. Only buys are recorded as signals.
 */
import { PublicKey } from "@solana/web3.js";
import { config } from "./config";
import { db, getKv, log } from "./db";
import { prepareBuyFast, readAccountFast, txSlot } from "./executor";
import { curveBuyTokens } from "./exits";
import { CurveFlow } from "./flow";
import { solUsd } from "./market";
import { strategyMode } from "./modes";
import { closePosition, openPosition, scheduleSellLadder, todaysPnlSol, watchOpenPositions } from "./positions";
import { type PortalTrade, startPortal } from "./pumpportal";
import { ata, bondingCurvePda, decodeBondingCurve, PUMP_DECIMALS, PUMP_PROGRAM, sleep } from "./solana";
import { stream } from "./stream";

const WEEK_MS = 7 * 864e5;
const PAPER_FEE_PCT = 1.5; // pump.fun curve fee (~1%) + PumpPortal's 0.5% Local API fee

type PortalCreate = PortalTrade & { vSolInBondingCurve?: number; vTokensInBondingCurve?: number; is_mayhem_mode?: boolean };

/* ---------- in-memory state, refreshed in the background ---------- */

export const launches7d = new Map<string, number>(); // creator → launches in the last 7 days
export const gradCreators = new Set<string>(); // creators with a graduated coin in our history
export const risk = { paused: false, dailyLossHit: false, openLaunch: 0 };
const boughtAt: number[] = []; // buy times in the last hour
const skipCounts = new Map<string, number>();
const stats = { seen: 0, watched: 0, fired: 0, expired: 0 };

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

/** Limits that can change while a coin is watched; checked at launch and again at the trigger. */
function capacity(): string | null {
  const now = Date.now();
  while (boughtAt.length && now - boughtAt[0] > 3600_000) boughtAt.shift();
  if (risk.paused) return "trading paused";
  if (risk.dailyLossHit) return "daily loss limit";
  if (risk.openLaunch + buying.size >= config.launchMaxOpen) return "max open positions";
  if (boughtAt.length >= config.launchMaxPerHour) return "hourly cap";
  return null;
}

/** Prefilters on the create event alone, in memory. Returns a skip reason or null to watch it. */
export function decide(m: PortalCreate): string | null {
  const devBuy = m.solAmount ?? 0;
  const creatorLaunches = Math.max(0, (launches7d.get(m.traderPublicKey) ?? 0) - 1); // minus this one
  const cap = capacity();
  if (cap) return cap;
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

/** Reads the coin's bonding curve and mint on the fast connection (one retry: a new account can lag). */
async function readLaunch(mint: string) {
  for (let i = 0; i < 2; i++) {
    const [info, mintInfo] = await Promise.all([
      readAccountFast(bondingCurvePda(mint)).catch(() => null),
      readAccountFast(new PublicKey(mint)).catch(() => null),
    ]);
    const bc = info && info.owner.equals(PUMP_PROGRAM) ? decodeBondingCurve(info.data as Buffer) : null;
    if (bc && mintInfo)
      return {
        vSol: Number(bc.virtualSolReserves) / 1e9,
        vTok: Number(bc.virtualTokenReserves) / 10 ** PUMP_DECIMALS,
        complete: bc.complete,
        lamports: info!.lamports, // for lamports-only notifications: vSol = lamports + offset
        tokenProgram: mintInfo.owner,
      };
    await sleep(400);
  }
  return null;
}

/* ---------- watching ---------- */

type Watch = {
  m: PortalCreate;
  flow: CurveFlow;
  subs: number[];
  timer: ReturnType<typeof setTimeout>;
  offsetLamports: number; // virtual SOL − account lamports, constant on a standard curve
  createSlot: number | null;
  positionId: number | null; // set once bought: the creator-sold watch stays on for the exit
};

const watching = new Map<string, Watch>();
const buying = new Set<string>();

function stopWatching(mint: string) {
  const w = watching.get(mint);
  if (!w) return;
  clearTimeout(w.timer);
  for (const s of w.subs) stream().unsubscribe(s);
  watching.delete(mint);
}

/** Curve notification: vSol from the decoded account when the provider sends data, else from lamports. */
function onCurve(w: Watch, r: any) {
  const v = r?.value;
  const slot = r?.context?.slot;
  if (!v || typeof slot !== "number" || w.positionId !== null) return;
  let vSol: number | null = null;
  if (Array.isArray(v.data) && v.data[1] === "base64") {
    const bc = decodeBondingCurve(Buffer.from(v.data[0], "base64"));
    if (bc?.complete) return stopWatching(w.m.mint);
    if (bc) vSol = Number(bc.virtualSolReserves) / 1e9;
  }
  if (vSol === null && typeof v.lamports === "number") vSol = (v.lamports + w.offsetLamports) / 1e9;
  if (!vSol || vSol <= 0) return;
  w.flow.update(slot, vSol);
  const sig = w.flow.signal({
    flowBlocks: config.launchFlowBlocks,
    minInflowSol: config.launchMinInflowSol,
    minBuyBlocks: config.launchMinBuyBlocks,
    maxCurveSol: config.launchMaxCurveSol,
    requireDevSold: config.launchRequireDevSold,
  });
  if (sig.fire && !buying.has(w.m.mint)) void fire(w, sig).catch(() => {});
}

/** Creator's token account: any drop in their balance means they sold. */
function onCreatorAccount(w: Watch, r: any, prev: { amount: number | null }) {
  const amt = Number(r?.value?.data?.parsed?.info?.tokenAmount?.amount ?? NaN);
  if (!Number.isFinite(amt)) return;
  const sold = prev.amount !== null && amt < prev.amount;
  prev.amount = amt;
  if (!sold || w.flow.devSold) return;
  w.flow.devSold = true;
  if (w.positionId !== null && config.launchExitOnDevSell) {
    closePosition(w.positionId, "creator sold").catch((e) => log("trade", `creator-sold exit failed on ${w.positionId}: ${(e as Error).message}`));
  }
}

async function fire(w: Watch, sig: ReturnType<CurveFlow["signal"]>) {
  const cap = capacity();
  if (cap) return; // keep watching: a slot may free up within the window
  const mint = w.m.mint;
  buying.add(mint);
  boughtAt.push(Date.now());
  stats.fired++;
  const size = config.launchSizeSol;
  const mode = await strategyMode("launch");
  try {
    if (mode === "off") return;
    // Live: PumpPortal builds the buy now. Paper: fill at the curve a moment later, about when a live
    // buy would land, so the price includes the buyers who'd beat us to it.
    const prepared = mode === "live" ? prepareBuyFast(mint, size) : null;
    if (mode === "paper") await sleep(config.launchPaperDelayMs);
    const paperTokens = mode === "paper" ? curveBuyTokens(w.flow.vSol, w.flow.vTok, size, PAPER_FEE_PCT) : undefined;
    let landedSlot: number | null = null;
    const pos = await openPosition({
      strategy: "launch",
      mode: mode === "live" ? "live" : "paper",
      mint,
      symbol: w.m.symbol ?? null,
      priceSol: w.flow.price,
      sizeSol: size,
      triggerWallets: [],
      sendLive: prepared?.send,
      paperTokens,
      onFill: (f) => (landedSlot = f.slot ?? null),
    });
    if (!pos) return;
    risk.openLaunch++;
    // Hand over: the price feed takes the curve; keep only the creator-sold watch, for the exit.
    w.positionId = pos.id;
    clearTimeout(w.timer);
    w.subs.slice(0, 1).forEach((s) => stream().unsubscribe(s));
    w.subs = w.subs.slice(1);
    w.timer = setTimeout(() => stopWatching(mint), (config.launchMaxHoldMin * 60 + 30) * 1000);
    scheduleSellLadder(pos);
    watchOpenPositions().catch(() => {});

    const entryBlock = (landedSlot ?? w.flow.slot) - (w.createSlot ?? w.flow.slot);
    const creatorLaunches = Math.max(0, (launches7d.get(w.m.traderPublicKey) ?? 1) - 1);
    const parts = [
      `${sig.inflowSol.toFixed(1)} SOL in over ${config.launchFlowBlocks} blocks (${sig.buyBlocks} buying blocks, price +${sig.risePct.toFixed(0)}%)`,
      `${mode === "live" ? "landed" : "entered"} ~${w.createSlot !== null ? entryBlock : "?"} blocks after launch`,
      `curve at ${sig.vSol.toFixed(0)} SOL`,
      `dev bought ${(w.m.solAmount ?? 0).toFixed(2)} SOL${w.flow.devSold ? ", already sold" : ""}`,
      `creator: ${creatorLaunches} other launch${creatorLaunches === 1 ? "" : "es"} in 7d${gradCreators.has(w.m.traderPublicKey) ? ", graduated before" : ""}`,
    ];
    const sol = await solUsd();
    await db.signal.create({
      data: {
        strategy: "launch",
        mint,
        symbol: w.m.symbol ?? null,
        reason: parts.join(" · "),
        wallets: [w.m.traderPublicKey],
        confluence: sig.buyBlocks,
        mcapUsd: pos.entryPriceSol * 1e9 * sol, // 1B supply
        ageMin: w.createSlot !== null ? (entryBlock * 0.4) / 60 : undefined,
        curvePct: Math.min(100, ((sig.vSol - 30) / 85) * 100),
        priceSol: pos.entryPriceSol,
        decision: "TAKEN",
        positionId: pos.id,
      },
    });
    await log("signal", `launch ${w.m.symbol ?? mint}: ${parts.join(" · ")} → TAKE (${mode})`);
  } catch (e) {
    await log("trade", `launch buy failed ${w.m.symbol ?? mint}: ${(e as Error).message}`);
    stopWatching(mint);
  } finally {
    buying.delete(mint);
  }
}

async function onCreate(m: PortalCreate) {
  if (m.traderPublicKey) launches7d.set(m.traderPublicKey, (launches7d.get(m.traderPublicKey) ?? 0) + 1);
  if ((await strategyMode("launch")) === "off") return; // cached in memory
  stats.seen++;
  const reason = decide(m);
  if (reason) return skip(reason);
  if (watching.size >= config.launchMaxWatching) return skip("watch list full");

  const c = await readLaunch(m.mint);
  const bad = curveCheck(m, c);
  if (bad) return skip(bad);

  const w: Watch = {
    m,
    flow: new CurveFlow(c!.vSol, c!.vTok),
    subs: [],
    timer: setTimeout(() => {
      stats.expired++;
      stopWatching(m.mint);
    }, config.launchWatchSec * 1000),
    offsetLamports: c!.vSol * 1e9 - c!.lamports,
    createSlot: null,
    positionId: null,
  };
  watching.set(m.mint, w);
  stats.watched++;
  txSlot(m.signature).then((s) => (w.createSlot = s), () => {});
  w.subs.push(
    stream().subscribe("accountSubscribe", [bondingCurvePda(m.mint).toBase58(), { encoding: "base64", commitment: "confirmed" }], (r) => onCurve(w, r)),
  );
  if ((m.solAmount ?? 0) > 0) {
    const prev = { amount: null as number | null };
    w.subs.push(
      stream().subscribe("accountSubscribe", [ata(m.traderPublicKey, m.mint, c!.tokenProgram).toBase58(), { encoding: "jsonParsed", commitment: "confirmed" }], (r) =>
        onCreatorAccount(w, r, prev),
      ),
    );
  }
}

async function summarise() {
  if (!stats.seen) return;
  const skipped = [...skipCounts].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`);
  await log(
    "signal",
    `launch sniper, last 10m: ${stats.seen} launches, ${stats.watched} watched, ${stats.fired} bought, ${stats.expired} showed no demand${skipped.length ? ` · skipped: ${skipped.join(", ")}` : ""}`,
  );
  Object.assign(stats, { seen: 0, watched: 0, fired: 0, expired: 0 });
  skipCounts.clear();
}

export const launchWatchCount = () => watching.size;

export function startLaunchStrategy() {
  refreshCreators().catch((e) => log("signal", `launch sniper: creator history load failed: ${(e as Error).message}`));
  refreshRisk().catch(() => {});
  setInterval(() => refreshCreators().catch(() => {}), 10 * 60_000);
  setInterval(() => refreshRisk().catch(() => {}), 2000);
  setInterval(() => summarise().catch(() => {}), 10 * 60_000);
  startPortal({ onCreate: (m) => void onCreate(m as PortalCreate).catch(() => {}) });
}
