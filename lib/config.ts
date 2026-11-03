const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean) =>
  v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase());

export function parseTpLevels(raw: string): { gainPct: number; sellPct: number }[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [g, p] = s.split(":").map(Number);
      return { gainPct: g, sellPct: p };
    })
    .filter((l) => Number.isFinite(l.gainPct) && Number.isFinite(l.sellPct) && l.sellPct > 0)
    .sort((a, b) => a.gainPct - b.gainPct);
}

export type StrategyMode = "off" | "paper" | "live";

const env = process.env;
const heliusKey = env.HELIUS_API_KEY ?? "";

export const config = {
  heliusKey,
  rpcUrl: env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
  wssUrl: env.SOLANA_WSS_URL || `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
  rpcFallbackUrls: (env.SOLANA_RPC_FALLBACK_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  rpcMaxRps: num(env.RPC_MAX_RPS, 10),
  pumpPortalKey: env.PUMPPORTAL_API_KEY ?? "",

  mode: (env.TRADING_MODE === "live" ? "live" : "paper") as "live" | "paper",
  traderKey: env.TRADER_PRIVATE_KEY ?? "",
  positionSizeSol: num(env.POSITION_SIZE_SOL, 0.1),
  maxOpenPositions: num(env.MAX_OPEN_POSITIONS, 5),
  dailyLossLimitSol: num(env.DAILY_LOSS_LIMIT_SOL, 0.5),
  slippageBps: num(env.SLIPPAGE_BPS, 1500),
  priorityFeeLamports: num(env.PRIORITY_FEE_LAMPORTS, 200_000),
  jitoUrl: env.JITO_URL || "https://mainnet.block-engine.jito.wtf",
  jitoTipLamports: num(env.JITO_TIP_LAMPORTS, 100_000),

  minConfluence: num(env.MIN_CONFLUENCE, 2),
  confluenceWindowMin: num(env.CONFLUENCE_WINDOW_MIN, 10),
  maxEntryMcapUsd: num(env.MAX_ENTRY_MCAP_USD, 150_000),
  maxTokenAgeMin: num(env.MAX_TOKEN_AGE_MIN, 120),
  maxTop10HolderPct: num(env.MAX_TOP10_HOLDER_PCT, 45),
  launcherSoloSignal: bool(env.LAUNCHER_SOLO_SIGNAL, true),
  maxDevHoldPct: num(env.MAX_DEV_HOLD_PCT, 10),
  maxLaunchSnipePct: num(env.MAX_LAUNCH_SNIPE_PCT, 15),
  maxCurveProgressPct: num(env.MAX_CURVE_PROGRESS_PCT, 95),
  maxPriceImpactPct: num(env.MAX_PRICE_IMPACT_PCT, 5),

  tpLevels: parseTpLevels(env.TAKE_PROFIT_LEVELS ?? "100:50,300:30,900:20"),
  stopLossPct: num(env.STOP_LOSS_PCT, 35),
  maxHoldMin: num(env.MAX_HOLD_MIN, 240),
  mirrorExits: bool(env.MIRROR_EXITS, true),
  // After the first take-profit (both strategies): protect the rest of the position.
  breakevenAfterTp: bool(env.BREAKEVEN_AFTER_TP, true),
  breakevenBufferPct: num(env.BREAKEVEN_BUFFER_PCT, 2), // sell the rest if it falls back to entry +2% (covers fees)
  trailAfterTpPct: num(env.TRAIL_AFTER_TP_PCT, 30), // ...or 30% below its peak, whichever is higher. 0 = off
  stopConfirmTicks: num(env.STOP_CONFIRM_TICKS, 2), // consecutive readings below a stop before selling
  maxRoundTripLossPct: num(env.MAX_ROUNDTRIP_LOSS_PCT, 10), // sellability: skip if buy→sell would lose more than this
  maxDevSoldPct: num(env.MAX_DEV_SOLD_PCT, 50), // skip if the creator already sold more than this % of their launch buy

  discoveryIntervalMin: num(env.DISCOVERY_INTERVAL_MIN, 360),
  watchlistSize: num(env.WATCHLIST_SIZE, 150),
  earlyBuyerCount: num(env.EARLY_BUYER_COUNT, 60),
  minWinnersForWatch: num(env.MIN_WINNERS_FOR_WATCH, 2),
  winnerMinPeakMcapUsd: num(env.WINNER_MIN_MCAP_USD, 250_000),
  // Wallets early on fewer winners than minWinnersForWatch can still be watched if their full history proves them.
  minWinnersWithHistory: num(env.MIN_WINNERS_WITH_HISTORY, 1),

  // Full-history vetting: a wallet must be profitable across ALL its recent trades, not just early on winners.
  histTxSample: num(env.HIST_TX_SAMPLE, 120),
  histPerRun: num(env.HIST_WALLETS_PER_RUN, 15),
  histMinTokens: num(env.HIST_MIN_TOKENS, 8),
  histMinWinRate: num(env.HIST_MIN_WIN_RATE, 0.35),
  histMinPnlSol: num(env.HIST_MIN_PNL_SOL, 0),
  histMaxTokensPerHour: num(env.HIST_MAX_TOKENS_PER_HOUR, 10),
  histRecheckDays: num(env.HIST_RECHECK_DAYS, 3),

  // Migration strategy: buy confirmed pump.fun graduations to PumpSwap.
  migrationMode: (["off", "paper", "live"].includes(env.MIGRATION_MODE ?? "") ? env.MIGRATION_MODE : "paper") as StrategyMode,
  migrationSizeSol: num(env.MIGRATION_SIZE_SOL, 0.05),
  migrationMaxOpen: num(env.MIGRATION_MAX_OPEN, 3),
  migrationDelaySec: num(env.MIGRATION_DELAY_SEC, 420), // decide after the BOOST window + 2 min of organic trading
  migrationBoostSec: num(env.MIGRATION_BOOST_SEC, 300), // pump.fun buyback window after migration
  migrationMinPoolSol: num(env.MIGRATION_MIN_POOL_SOL, 30),
  migrationMaxDropPct: num(env.MIGRATION_MAX_DROP_PCT, 10), // vs the fixed graduation price
  migrationMaxPumpPct: num(env.MIGRATION_MAX_PUMP_PCT, 100), // vs the fixed graduation price
  migrationMinBuyRatio: num(env.MIGRATION_MIN_BUY_RATIO, 1.2), // buys ÷ sells after the BOOST window
  migrationMinTraders: num(env.MIGRATION_MIN_TRADERS, 15), // distinct traders after the BOOST window
  migrationMinSmartWallets: num(env.MIGRATION_MIN_SMART_WALLETS, 0),
  migrationMinFillMin: num(env.MIGRATION_MIN_FILL_MIN, 10), // launch → graduation faster than this = manufactured
  migrationTpLevels: parseTpLevels(env.MIGRATION_TAKE_PROFIT_LEVELS ?? "30:50,100:25,200:25"),
  migrationStopLossPct: num(env.MIGRATION_STOP_LOSS_PCT, 25),
  migrationMaxHoldMin: num(env.MIGRATION_MAX_HOLD_MIN, 60),

  telegramToken: env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: env.TELEGRAM_CHAT_ID ?? "",
  adminToken: env.ADMIN_TOKEN ?? "",
};

export type Config = typeof config;
