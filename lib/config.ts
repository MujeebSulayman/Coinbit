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

const env = process.env;
const heliusKey = env.HELIUS_API_KEY ?? "";

export const config = {
  heliusKey,
  rpcUrl: env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`,
  wssUrl: env.SOLANA_WSS_URL || `wss://mainnet.helius-rpc.com/?api-key=${heliusKey}`,

  mode: (env.TRADING_MODE === "live" ? "live" : "paper") as "live" | "paper",
  traderKey: env.TRADER_PRIVATE_KEY ?? "",
  positionSizeSol: num(env.POSITION_SIZE_SOL, 0.1),
  maxOpenPositions: num(env.MAX_OPEN_POSITIONS, 5),
  dailyLossLimitSol: num(env.DAILY_LOSS_LIMIT_SOL, 0.5),
  slippageBps: num(env.SLIPPAGE_BPS, 1500),
  priorityFeeLamports: num(env.PRIORITY_FEE_LAMPORTS, 200_000),
  jitoUrl: env.JITO_URL ?? "",

  minConfluence: num(env.MIN_CONFLUENCE, 2),
  confluenceWindowMin: num(env.CONFLUENCE_WINDOW_MIN, 10),
  maxEntryMcapUsd: num(env.MAX_ENTRY_MCAP_USD, 150_000),
  maxTokenAgeMin: num(env.MAX_TOKEN_AGE_MIN, 120),
  maxTop10HolderPct: num(env.MAX_TOP10_HOLDER_PCT, 45),
  launcherSoloSignal: bool(env.LAUNCHER_SOLO_SIGNAL, true),

  tpLevels: parseTpLevels(env.TAKE_PROFIT_LEVELS ?? "100:50,300:30,900:20"),
  stopLossPct: num(env.STOP_LOSS_PCT, 35),
  maxHoldMin: num(env.MAX_HOLD_MIN, 240),
  mirrorExits: bool(env.MIRROR_EXITS, true),

  discoveryIntervalMin: num(env.DISCOVERY_INTERVAL_MIN, 360),
  watchlistSize: num(env.WATCHLIST_SIZE, 150),
  earlyBuyerCount: num(env.EARLY_BUYER_COUNT, 60),
  minWinnersForWatch: num(env.MIN_WINNERS_FOR_WATCH, 2),
  winnerMinPeakMcapUsd: num(env.WINNER_MIN_MCAP_USD, 500_000),

  telegramToken: env.TELEGRAM_BOT_TOKEN ?? "",
  telegramChatId: env.TELEGRAM_CHAT_ID ?? "",
  adminToken: env.ADMIN_TOKEN ?? "",
};

export type Config = typeof config;
