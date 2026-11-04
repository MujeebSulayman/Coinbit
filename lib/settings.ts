/**
 * Runtime settings editable from the dashboard. Overrides are stored in the database (Kv) and the
 * worker applies them to `config` every few seconds, so changes need no redeploy or restart.
 *
 * Precedence: dashboard override → env var → code default. Secrets and RPC URLs are deliberately
 * not editable here; neither are settings that are only read at startup.
 */
import { config, parseTpLevels } from "./config";
import { getKv, setKv } from "./db";

export type SettingKind = "num" | "int" | "bool" | "ladder";
export type SettingDef = {
  key: keyof typeof config;
  env: string;
  label: string;
  group: string;
  kind: SettingKind;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  help: string;
};

const d = (
  group: string,
  key: keyof typeof config,
  env: string,
  label: string,
  kind: SettingKind,
  help: string,
  opts: Partial<Pick<SettingDef, "unit" | "min" | "max" | "step">> = {},
): SettingDef => ({ group, key, env, label, kind, help, ...opts });

export const GROUPS = [
  "Trade size & risk",
  "Execution",
  "Exits · copy trading",
  "Exits · migration",
  "Exits · after first take-profit",
  "Exits · early warning",
  "Entry filters · copy trading",
  "Entry filters · migration",
  "Discovery & wallet vetting",
] as const;

export const SETTINGS: SettingDef[] = [
  d(GROUPS[0], "positionSizeSol", "POSITION_SIZE_SOL", "Copy trade size", "num", "SOL per copy trade.", { unit: "SOL", min: 0.001, max: 100, step: 0.01 }),
  d(GROUPS[0], "migrationSizeSol", "MIGRATION_SIZE_SOL", "Migration trade size", "num", "SOL per migration trade.", { unit: "SOL", min: 0.001, max: 100, step: 0.01 }),
  d(GROUPS[0], "maxOpenPositions", "MAX_OPEN_POSITIONS", "Max open · copy", "int", "Copy positions open at once.", { min: 1, max: 50 }),
  d(GROUPS[0], "migrationMaxOpen", "MIGRATION_MAX_OPEN", "Max open · migration", "int", "Migration positions open at once.", { min: 1, max: 50 }),
  d(GROUPS[0], "dailyLossLimitSol", "DAILY_LOSS_LIMIT_SOL", "Daily loss limit", "num", "Trading pauses automatically after losing this much in a day (GMT+1). Shared by both strategies.", { unit: "SOL", min: 0.01, max: 1000, step: 0.1 }),

  d(GROUPS[1], "slippageBps", "SLIPPAGE_BPS", "Slippage", "int", "Max slippage on buys, in basis points (100 = 1%). Sells widen it on retries.", { unit: "bps", min: 50, max: 5000 }),
  d(GROUPS[1], "priorityFeeLamports", "PRIORITY_FEE_LAMPORTS", "Priority fee", "int", "Per transaction, in lamports (1 SOL = 1,000,000,000). Doubles on each sell retry.", { unit: "lamports", min: 0, max: 10_000_000 }),
  d(GROUPS[1], "jitoTipLamports", "JITO_TIP_LAMPORTS", "Jito tip", "int", "Tip for the Jito bundle; only paid if Jito lands the trade. 0 = off.", { unit: "lamports", min: 0, max: 10_000_000 }),

  d(GROUPS[2], "tpLevels", "TAKE_PROFIT_LEVELS", "Take-profit ladder", "ladder", "gain%:sell% steps, e.g. 100:50,300:30,900:20 sells 50% of the bag at +100%, 30% at +300%…"),
  d(GROUPS[2], "stopLossPct", "STOP_LOSS_PCT", "Stop-loss", "num", "Sell everything at this loss (before the first take-profit).", { unit: "%", min: 1, max: 95, step: 1 }),
  d(GROUPS[2], "maxHoldMin", "MAX_HOLD_MIN", "Time limit", "int", "Close after this long regardless.", { unit: "min", min: 1, max: 10_080 }),
  d(GROUPS[2], "mirrorExits", "MIRROR_EXITS", "Mirror exits", "bool", "Sell when most of the wallets that triggered the trade sell."),

  d(GROUPS[3], "migrationTpLevels", "MIGRATION_TAKE_PROFIT_LEVELS", "Take-profit ladder", "ladder", "gain%:sell% steps for migration trades."),
  d(GROUPS[3], "migrationStopLossPct", "MIGRATION_STOP_LOSS_PCT", "Stop-loss", "num", "Sell everything at this loss (before the first take-profit).", { unit: "%", min: 1, max: 95, step: 1 }),
  d(GROUPS[3], "migrationMaxHoldMin", "MIGRATION_MAX_HOLD_MIN", "Time limit", "int", "Close after this long regardless.", { unit: "min", min: 1, max: 10_080 }),

  d(GROUPS[4], "breakevenAfterTp", "BREAKEVEN_AFTER_TP", "Break-even stop", "bool", "After the first take-profit, sell the rest if it falls back to entry + buffer."),
  d(GROUPS[4], "breakevenBufferPct", "BREAKEVEN_BUFFER_PCT", "Break-even buffer", "num", "Above entry, to cover fees.", { unit: "%", min: 0, max: 50, step: 0.5 }),
  d(GROUPS[4], "trailAfterTpPct", "TRAIL_AFTER_TP_PCT", "Trailing stop", "num", "After the first take-profit, sell the rest if it falls this far below its peak. 0 = off.", { unit: "%", min: 0, max: 90, step: 1 }),
  d(GROUPS[4], "stopConfirmTicks", "STOP_CONFIRM_TICKS", "Stop confirmation", "int", "Consecutive price readings below a stop before selling (ignores single wicks).", { unit: "readings", min: 1, max: 10 }),

  d("Exits · early warning", "insiderExit", "INSIDER_EXIT", "Insider-dump exit", "bool", "Sell everything right away if the coin's top-5 holders sell off together, or one big holder dumps (the usual start of a rug)."),
  d("Exits · early warning", "insiderMinHoldPct", "INSIDER_MIN_HOLD_PCT", "Holder size to watch", "num", "Watch the top 5 wallets holding at least this share of supply. Single-holder trigger needs 3× this.", { unit: "%", min: 0.1, max: 50, step: 0.1 }),
  d("Exits · early warning", "insiderSellPct", "INSIDER_SELL_PCT", "Dump threshold", "num", "Triggers when the watched holders together (or one big holder) have sold this share.", { unit: "%", min: 10, max: 100 }),
  d("Exits · early warning", "momentumExit", "MOMENTUM_EXIT", "Momentum-fade exit", "bool", "After the first take-profit, sell the rest when sellers clearly take over."),
  d("Exits · early warning", "momentumWindowSec", "MOMENTUM_WINDOW_SEC", "Momentum window", "int", "How far back to measure buys vs sells.", { unit: "sec", min: 15, max: 600 }),
  d("Exits · early warning", "momentumSellRatio", "MOMENTUM_SELL_RATIO", "Sell pressure", "num", "Exit when SOL sold is at least this many times SOL bought in the window.", { unit: "×", min: 1, max: 20, step: 0.1 }),
  d("Exits · early warning", "momentumMinTrades", "MOMENTUM_MIN_TRADES", "Min trades", "int", "Ignore quiet windows with fewer trades than this.", { min: 1, max: 100 }),

  d(GROUPS[6], "minConfluence", "MIN_CONFLUENCE", "Wallets needed", "int", "Watched wallets that must buy the same coin.", { min: 1, max: 10 }),
  d(GROUPS[6], "confluenceWindowMin", "CONFLUENCE_WINDOW_MIN", "…within", "int", "Minutes in which those buys must happen.", { unit: "min", min: 1, max: 240 }),
  d(GROUPS[6], "launcherSoloSignal", "LAUNCHER_SOLO_SIGNAL", "Launcher solo signal", "bool", "A proven launcher creating a coin can trigger a trade alone."),
  d(GROUPS[6], "maxEntryMcapUsd", "MAX_ENTRY_MCAP_USD", "Max market cap", "int", "Skip coins already bigger than this.", { unit: "USD", min: 1000, max: 100_000_000 }),
  d(GROUPS[6], "maxTokenAgeMin", "MAX_TOKEN_AGE_MIN", "Max coin age", "int", "Skip coins older than this.", { unit: "min", min: 1, max: 10_080 }),
  d(GROUPS[6], "maxTop10HolderPct", "MAX_TOP10_HOLDER_PCT", "Max top-10 holders", "num", "Skip if the top 10 holders (excluding curve/pool) own more. Also used by migration.", { unit: "%", min: 1, max: 100 }),
  d(GROUPS[6], "maxDevHoldPct", "MAX_DEV_HOLD_PCT", "Max dev holding", "num", "Skip if the creator holds more. Also used by migration.", { unit: "%", min: 0, max: 100 }),
  d(GROUPS[6], "maxLaunchSnipePct", "MAX_LAUNCH_SNIPE_PCT", "Max launch snipers", "num", "Skip if others bought more than this in the launch block (bundles).", { unit: "%", min: 0, max: 100 }),
  d(GROUPS[6], "maxDevSoldPct", "MAX_DEV_SOLD_PCT", "Max dev sold", "num", "Skip if the creator already sold more than this share of their launch buy.", { unit: "%", min: 0, max: 100 }),
  d(GROUPS[6], "maxCurveProgressPct", "MAX_CURVE_PROGRESS_PCT", "Max curve progress", "num", "Skip coins about to graduate.", { unit: "%", min: 1, max: 100 }),
  d(GROUPS[6], "maxPriceImpactPct", "MAX_PRICE_IMPACT_PCT", "Max price impact", "num", "Skip if our buy would move the price more than this.", { unit: "%", min: 0.1, max: 50, step: 0.1 }),
  d(GROUPS[6], "maxRoundTripLossPct", "MAX_ROUNDTRIP_LOSS_PCT", "Max round-trip loss", "num", "Sellability check: skip if a buy then sell would lose more (both strategies).", { unit: "%", min: 1, max: 100 }),

  d(GROUPS[7], "migrationDelaySec", "MIGRATION_DELAY_SEC", "Decision delay", "int", "Seconds after graduation before deciding (BOOST buybacks run ~300s).", { unit: "sec", min: 30, max: 3600 }),
  d(GROUPS[7], "migrationMinPoolSol", "MIGRATION_MIN_POOL_SOL", "Min pool SOL", "num", "Real SOL in the PumpSwap pool.", { unit: "SOL", min: 0, max: 1000 }),
  d(GROUPS[7], "migrationMaxDropPct", "MIGRATION_MAX_DROP_PCT", "Max below graduation price", "num", "Skip if price is more than this below the graduation price.", { unit: "%", min: 0, max: 100 }),
  d(GROUPS[7], "migrationMaxPumpPct", "MIGRATION_MAX_PUMP_PCT", "Max above graduation price", "num", "Skip if it already ran more than this.", { unit: "%", min: 0, max: 10_000 }),
  d(GROUPS[7], "migrationMinBuyRatio", "MIGRATION_MIN_BUY_RATIO", "Min buys ÷ sells", "num", "After the BOOST window.", { min: 0, max: 20, step: 0.1 }),
  d(GROUPS[7], "migrationMinTraders", "MIGRATION_MIN_TRADERS", "Min traders", "int", "Distinct traders after the BOOST window.", { min: 0, max: 1000 }),
  d(GROUPS[7], "migrationMinFillMin", "MIGRATION_MIN_FILL_MIN", "Min launch → graduation", "int", "Faster than this = manufactured graduation.", { unit: "min", min: 0, max: 1440 }),
  d(GROUPS[7], "migrationMinSmartWallets", "MIGRATION_MIN_SMART_WALLETS", "Min smart wallets holding", "int", "Watched wallets that must hold the coin.", { min: 0, max: 50 }),

  d(GROUPS[8], "discoveryIntervalMin", "DISCOVERY_INTERVAL_MIN", "Discovery interval", "int", "How often to look for new winners and early buyers.", { unit: "min", min: 5, max: 1440 }),
  d(GROUPS[8], "watchlistSize", "WATCHLIST_SIZE", "Watchlist size", "int", "Max wallets watched live.", { min: 1, max: 1000 }),
  d(GROUPS[8], "winnerMinPeakMcapUsd", "WINNER_MIN_MCAP_USD", "Winner market cap", "int", "A coin counts as a winner above this peak market cap.", { unit: "USD", min: 10_000, max: 1_000_000_000 }),
  d(GROUPS[8], "earlyBuyerCount", "EARLY_BUYER_COUNT", "Early buyers per winner", "int", "First N buyers recorded for each winner.", { min: 5, max: 500 }),
  d(GROUPS[8], "minWinnersForWatch", "MIN_WINNERS_FOR_WATCH", "Winners to qualify", "int", "Early on this many winners qualifies on its own.", { min: 1, max: 20 }),
  d(GROUPS[8], "minWinnersWithHistory", "MIN_WINNERS_WITH_HISTORY", "Winners if history proves it", "int", "Fewer winners are enough when the full trading history passes.", { min: 1, max: 20 }),
  d(GROUPS[8], "histMinWinRate", "HIST_MIN_WIN_RATE", "Min win rate", "num", "Across all coins in the sampled history (0–1).", { min: 0, max: 1, step: 0.01 }),
  d(GROUPS[8], "histMinPnlSol", "HIST_MIN_PNL_SOL", "Min history PnL", "num", "Net PnL across the sample, incl. coins still held.", { unit: "SOL", min: -1000, max: 1000, step: 0.1 }),
  d(GROUPS[8], "histMinTokens", "HIST_MIN_TOKENS", "Min coins to judge", "int", "Coins needed in the sample before judging.", { min: 1, max: 200 }),
  d(GROUPS[8], "histMaxTokensPerHour", "HIST_MAX_TOKENS_PER_HOUR", "Bot threshold", "num", "Trading more coins per hour than this = bot.", { unit: "coins/h", min: 1, max: 1000 }),
  d(GROUPS[8], "histTxSample", "HIST_TX_SAMPLE", "History sample", "int", "Recent transactions checked per wallet (more = slower, more RPC).", { unit: "txs", min: 20, max: 1000 }),
  d(GROUPS[8], "histPerRun", "HIST_WALLETS_PER_RUN", "Wallets vetted per pass", "int", "Per vetting pass.", { min: 1, max: 200 }),
  d(GROUPS[8], "histRecheckDays", "HIST_RECHECK_DAYS", "Re-vet after", "num", "Days before a wallet's history is checked again.", { unit: "days", min: 0.5, max: 60, step: 0.5 }),
];

const byKey = new Map(SETTINGS.map((s) => [s.key as string, s]));
export type Overrides = Record<string, unknown>;
type Ladder = { gainPct: number; sellPct: number }[];

/** Validates one raw input. Returns the typed value, or an error message. */
export function parseSetting(key: string, raw: unknown): { value: unknown } | { error: string } {
  const def = byKey.get(key);
  if (!def) return { error: `unknown setting ${key}` };
  if (def.kind === "bool") {
    if (typeof raw === "boolean") return { value: raw };
    if (raw === "true" || raw === "false") return { value: raw === "true" };
    return { error: `${def.label}: expected on/off` };
  }
  if (def.kind === "ladder") {
    const levels = Array.isArray(raw) ? (raw as Ladder) : parseTpLevels(String(raw ?? ""));
    if (!levels.length) return { error: `${def.label}: use gain:sell pairs like 30:50,100:25` };
    const total = levels.reduce((s, l) => s + l.sellPct, 0);
    if (levels.some((l) => l.gainPct <= 0 || l.sellPct <= 0)) return { error: `${def.label}: gains and sells must be positive` };
    if (total > 100.0001) return { error: `${def.label}: sells add up to ${total}%, max 100%` };
    return { value: levels };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isFinite(n)) return { error: `${def.label}: not a number` };
  if (def.kind === "int" && !Number.isInteger(n)) return { error: `${def.label}: must be a whole number` };
  if (def.min !== undefined && n < def.min) return { error: `${def.label}: minimum ${def.min}` };
  if (def.max !== undefined && n > def.max) return { error: `${def.label}: maximum ${def.max}` };
  return { value: n };
}

const OVERRIDES_KEY = "settings:overrides";
const EFFECTIVE_KEY = "settings:effective";

export async function getOverrides(): Promise<Overrides> {
  try {
    return JSON.parse((await getKv(OVERRIDES_KEY)) ?? "{}") as Overrides;
  } catch {
    return {};
  }
}

export async function saveOverrides(o: Overrides) {
  await setKv(OVERRIDES_KEY, JSON.stringify(o));
}

/** Values as configured before any dashboard override (env var or code default), captured at startup. */
const baseline: Record<string, unknown> = Object.fromEntries(SETTINGS.map((s) => [s.key, structuredClone(config[s.key])]));

/**
 * Worker: applies dashboard overrides onto the live config (falling back to the baseline when an
 * override is removed), then publishes the effective values so the dashboard shows what's in force.
 */
export async function applyOverrides() {
  const o = await getOverrides();
  const cfg = config as Record<string, unknown>;
  for (const s of SETTINGS) {
    const parsed = s.key in o ? parseSetting(s.key, o[s.key]) : null;
    cfg[s.key] = parsed && "value" in parsed ? parsed.value : structuredClone(baseline[s.key]);
  }
  const values = Object.fromEntries(SETTINGS.map((s) => [s.key, cfg[s.key]]));
  await setKv(EFFECTIVE_KEY, JSON.stringify({ at: new Date().toISOString(), values, baseline }));
}

/** Dashboard: what the worker reports as in force (or this process's view if the worker hasn't reported). */
export async function effectiveSettings(): Promise<{ at: string | null; values: Record<string, unknown>; baseline: Record<string, unknown> }> {
  try {
    const raw = await getKv(EFFECTIVE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { at: null, values: { ...baseline }, baseline };
}

export const formatLadder = (l: Ladder) => l.map((x) => `${x.gainPct}:${x.sellPct}`).join(",");
