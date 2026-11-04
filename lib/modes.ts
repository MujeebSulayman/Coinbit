/**
 * Per-strategy trading mode: off | paper | live. Defaults come from .env (TRADING_MODE for copy
 * trading, MIGRATION_MODE for migration, LAUNCH_MODE for the launch sniper); the dashboard can override them at runtime.
 */
import { config, type StrategyMode } from "./config";
import { getKv, log, setKv } from "./db";

export const STRATEGIES = ["copy", "migration", "launch"] as const;
export type Strategy = (typeof STRATEGIES)[number];

const defaults: Record<Strategy, StrategyMode> = {
  copy: config.mode,
  migration: config.migrationMode,
  launch: config.launchMode,
};

const cache = new Map<Strategy, { v: StrategyMode; at: number }>();

export async function strategyMode(s: Strategy): Promise<StrategyMode> {
  const c = cache.get(s);
  if (c && Date.now() - c.at < 5000) return c.v;
  const kv = (await getKv(`mode:${s}`)) as StrategyMode | null;
  let v = kv && ["off", "paper", "live"].includes(kv) ? kv : defaults[s];
  // Safety net in the worker: live without a key can't trade, so fall back to paper.
  if (v === "live" && !config.traderKey && process.env.COINBIT_ROLE === "worker") {
    if (!c || c.v !== "paper") await log("worker", `${s} is set to LIVE but TRADER_PRIVATE_KEY is missing; running as PAPER`);
    v = "paper";
  }
  cache.set(s, { v, at: Date.now() });
  return v;
}

/** The private key lives only on the worker; it reports in its heartbeat whether it can trade live. */
async function workerCanTradeLive(): Promise<boolean> {
  if (config.traderKey) return true;
  const hb = await getKv("worker:heartbeat");
  try {
    return !!hb && JSON.parse(hb).canTradeLive === true;
  } catch {
    return false;
  }
}

export async function setStrategyMode(s: Strategy, m: StrategyMode) {
  if (m === "live" && !(await workerCanTradeLive()))
    throw new Error("live mode needs TRADER_PRIVATE_KEY set on the worker");
  await setKv(`mode:${s}`, m);
  cache.delete(s);
}

export async function allModes(): Promise<Record<Strategy, StrategyMode>> {
  return { copy: await strategyMode("copy"), migration: await strategyMode("migration"), launch: await strategyMode("launch") };
}
