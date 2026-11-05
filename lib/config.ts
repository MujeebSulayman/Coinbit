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
  jupiterApiKey: env.JUPITER_API_KEY ?? "", // free at portal.jup.ag: doubles Jupiter's rate limit and uses api.jup.ag

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

  // Coins not priced in SOL (non-standard curves, or pools quoted in another token): off = skip them.
  // On = trade them only if Jupiter's SOL quote and DexScreener's USD price (converted) agree.
  copyMinMcapUsd: num(env.COPY_MIN_MCAP_USD, 8000), // skip coins smaller than this (mostly seconds-old curve coins)
  copyAutoBlockMinTrades: num(env.COPY_AUTO_BLOCK_MIN_TRADES, 5), // judge a wallet after this many copies...
  copyAutoBlockMaxWinPct: num(env.COPY_AUTO_BLOCK_MAX_WIN_PCT, 25), // ...block it if fewer than this % of them won (0 = off)
  copyAutoBlockFlipPct: num(env.COPY_AUTO_BLOCK_FLIP_PCT, 60), // ...or if this % of them closed within seconds because it sold, at a net loss
  copyAllowNonSol: bool(env.COPY_ALLOW_NON_SOL, false),
  copyNonSolMaxGapPct: num(env.COPY_NON_SOL_MAX_GAP_PCT, 15),
  tpLevels: parseTpLevels(env.TAKE_PROFIT_LEVELS ?? "100:50,300:30,900:20"),
  stopLossPct: num(env.STOP_LOSS_PCT, 35),
  maxHoldMin: num(env.MAX_HOLD_MIN, 240),
  mirrorExits: bool(env.MIRROR_EXITS, true),
  // After the first take-profit (both strategies): protect the rest of the position.
  breakevenAfterTp: bool(env.BREAKEVEN_AFTER_TP, true),
  breakevenBufferPct: num(env.BREAKEVEN_BUFFER_PCT, 2), // sell the rest if it falls back to entry +2% (covers fees)
  trailAfterTpPct: num(env.TRAIL_AFTER_TP_PCT, 30), // ...or 30% below its peak, whichever is higher. 0 = off
  stopConfirmTicks: num(env.STOP_CONFIRM_TICKS, 2), // consecutive readings below a stop before selling
  // Early-warning exits (both strategies)
  insiderExit: bool(env.INSIDER_EXIT, true), // sell everything if a top holder dumps
  insiderMinHoldPct: num(env.INSIDER_MIN_HOLD_PCT, 1), // watch the top-5 wallets holding at least this % of supply
  insiderSellPct: num(env.INSIDER_SELL_PCT, 50), // trigger when together (or one ≥3× min holder) they've sold this share
  momentumExit: bool(env.MOMENTUM_EXIT, true), // after TP1: sell the rest when sellers clearly take over
  momentumWindowSec: num(env.MOMENTUM_WINDOW_SEC, 90),
  momentumSellRatio: num(env.MOMENTUM_SELL_RATIO, 2), // sell SOL ≥ this × buy SOL in the window
  momentumMinTrades: num(env.MOMENTUM_MIN_TRADES, 5), // ...with at least this many trades in the window
  // Exits for every strategy (on top of each strategy's take-profit ladder, stop-loss and time limit)
  profitLockArmPct: num(env.PROFIT_LOCK_ARM_PCT, 10), // once the peak gain reaches this... 0 = off
  profitLockKeepPct: num(env.PROFIT_LOCK_KEEP_PCT, 55), // ...sell the rest if it gives back more than (100 − this)% of it
  quoteShockPct: num(env.QUOTE_SHOCK_PCT, 20), // sell at once if the price falls this far from its recent high... 0 = off
  quoteShockWindowSec: num(env.QUOTE_SHOCK_WINDOW_SEC, 10), // ...within this many seconds (confirmed by a fresh sell quote)
  stagnantMin: num(env.STAGNANT_MIN, 10), // sell a position that has gone nowhere for this long... 0 = off
  stagnantBandPct: num(env.STAGNANT_BAND_PCT, 10), // ..."nowhere" = never up this much and still within ± this of entry
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
  histPerRun: num(env.HIST_WALLETS_PER_RUN, 30),
  vetIntervalMin: num(env.VET_INTERVAL_MIN, 5), // background vetting cadence between discovery runs
  histMinTokens: num(env.HIST_MIN_TOKENS, 20), // research guides use 50–100 trades; our 120-tx sample caps it lower
  histMinWinRate: num(env.HIST_MIN_WIN_RATE, 0.4),
  histMinPnlSol: num(env.HIST_MIN_PNL_SOL, 0),
  histMaxTokensPerHour: num(env.HIST_MAX_TOKENS_PER_HOUR, 10),
  histRecheckDays: num(env.HIST_RECHECK_DAYS, 3),
  histMinMedianHoldSec: num(env.HIST_MIN_MEDIAN_HOLD_SEC, 120), // followability: too-fast wallets can't be copied in time
  histMaxQuickSellPct: num(env.HIST_MAX_QUICK_SELL_PCT, 30), // …nor ones that often sell within 30s
  histMaxTopCreatorPct: num(env.HIST_MAX_TOP_CREATOR_PCT, 30), // insiders: too many coins from one creator
  histMaxBestCoinPct: num(env.HIST_MAX_BEST_COIN_PCT, 70), // one-hit wonders: most profit from a single coin
  watchMaxIdleHours: num(env.WATCH_MAX_IDLE_HOURS, 48), // replace watched wallets that stopped trading
  copyMergeLinked: bool(env.COPY_MERGE_LINKED, false), // count linked wallets once (off: past data didn't support it, see lib/linked)
  copyLinkWindowSec: num(env.COPY_LINK_WINDOW_SEC, 150), // two wallets buying the same coin this close together…
  copyLinkMinCoBuys: num(env.COPY_LINK_MIN_CO_BUYS, 3), // …on this many coins count as one decision
  copyLinkMinSharePct: num(env.COPY_LINK_MIN_SHARE_PCT, 50), // …and on at least this share of the smaller wallet's coins

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
  migrationMinLiquidityUsd: num(env.MIGRATION_MIN_LIQUIDITY_USD, 13_000), // both sides of the pool, in USD
  migrationSkipLongRun: bool(env.MIGRATION_SKIP_LONG_RUN, true), // 1000+ curve txs before graduating: median −51% at 60m in our data
  migrationMaxQuoteDriftPct: num(env.MIGRATION_MAX_QUOTE_DRIFT_PCT, 5), // re-quote just before buying; skip if it moved more
  migrationMinFillMin: num(env.MIGRATION_MIN_FILL_MIN, 10), // launch → graduation faster than this = manufactured
  // Research filters, off by default: recorded on every signal and compared on the Performance page first.
  migrationMinSocials: num(env.MIGRATION_MIN_SOCIALS, 0), // of X / Telegram / website; 0 = off
  migrationRequireProvenDev: bool(env.MIGRATION_REQUIRE_PROVEN_DEV, false), // dev graduated before + no launches in 7d
  migrationTpLevels: parseTpLevels(env.MIGRATION_TAKE_PROFIT_LEVELS ?? "30:50,100:25,200:25"),
  migrationStopLossPct: num(env.MIGRATION_STOP_LOSS_PCT, 25),
  migrationMaxHoldMin: num(env.MIGRATION_MAX_HOLD_MIN, 60),

  // Launch sniper: buys new pump.fun coins seconds after creation (PumpPortal feed + Local Transaction API).
  launchMode: (["off", "paper", "live"].includes(env.LAUNCH_MODE ?? "") ? env.LAUNCH_MODE : "off") as StrategyMode,
  launchSizeSol: num(env.LAUNCH_SIZE_SOL, 0.05),
  launchMaxOpen: num(env.LAUNCH_MAX_OPEN, 3),
  launchMaxPerHour: num(env.LAUNCH_MAX_PER_HOUR, 20), // buys per rolling hour (pump.fun sees ~30k launches a day)
  launchMinDevBuySol: num(env.LAUNCH_MIN_DEV_BUY_SOL, 0), // creator's own buy in the create tx
  launchMaxDevBuySol: num(env.LAUNCH_MAX_DEV_BUY_SOL, 5), // big dev bags are dump risk
  launchMaxCreatorLaunches7d: num(env.LAUNCH_MAX_CREATOR_LAUNCHES_7D, 3), // serial launchers: other coins in 7 days
  launchRequireProvenDev: bool(env.LAUNCH_REQUIRE_PROVEN_DEV, false), // creator graduated a coin before
  launchSlippagePct: num(env.LAUNCH_SLIPPAGE_PCT, 25),
  launchPriorityFeeSol: num(env.LAUNCH_PRIORITY_FEE_SOL, 0.0005),
  // "Drafter" entry: watch each candidate's curve after launch and buy only into real demand.
  launchWatchSec: num(env.LAUNCH_WATCH_SEC, 60), // give up on a coin if demand hasn't shown by then
  launchMaxWatching: num(env.LAUNCH_MAX_WATCHING, 40), // coins watched at once (one or two subscriptions each)
  launchFlowBlocks: num(env.LAUNCH_FLOW_BLOCKS, 10), // demand window (1 block ≈ 0.4s)
  launchMinInflowSol: num(env.LAUNCH_MIN_INFLOW_SOL, 5), // net SOL bought within the window
  launchMinBuyBlocks: num(env.LAUNCH_MIN_BUY_BLOCKS, 4), // blocks with net buying within the window
  launchMaxCurveSol: num(env.LAUNCH_MAX_CURVE_SOL, 85), // curve's virtual SOL (starts at 30, completes ~115)
  launchRequireDevSold: bool(env.LAUNCH_REQUIRE_DEV_SOLD, false), // only buy after the creator has sold
  launchPaperDelayMs: num(env.LAUNCH_PAPER_DELAY_MS, 1200), // paper fills at the curve this long after the trigger (≈ live landing time)
  // Exit: a sell ladder timed in blocks after the buy, "block:sell%" (all of it out within ~10s).
  launchSellLadder: parseTpLevels(env.LAUNCH_SELL_LADDER ?? "1:20,5:15,10:15,15:15,20:15,25:20"),
  launchExitOnDevSell: bool(env.LAUNCH_EXIT_ON_DEV_SELL, true), // sell everything the moment the creator sells
  launchStopLossPct: num(env.LAUNCH_STOP_LOSS_PCT, 20), // the drafter dumped everything at 0.8×
  launchMaxHoldMin: num(env.LAUNCH_MAX_HOLD_MIN, 1), // safety net behind the ladder

  telegramToken: env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: env.TELEGRAM_CHAT_ID ?? "",
  adminToken: env.ADMIN_TOKEN ?? "",
};

export type Config = typeof config;
