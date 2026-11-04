/**
 * Coinbit worker — the long-running bot process.
 *   npm run worker
 * Runs discovery on a schedule, listens to watched wallets, opens and manages positions.
 * Deploy this on an always-on host (VPS / Railway / Fly). The Next.js dashboard can live on Vercel.
 */
import "dotenv/config";
process.env.COINBIT_ROLE = "worker";
import { config } from "../lib/config";
import { db, getKv, log, setKv } from "../lib/db";
import { runDiscovery, vetMore } from "../lib/discovery";
import { sweepEmptyTokenAccounts } from "../lib/executor";
import { startLaunchStrategy } from "../lib/launch";
import { startMigrationStrategy } from "../lib/migration";
import { allModes, strategyMode } from "../lib/modes";
import { liveFeedCount } from "../lib/pricefeed";
import { pruneOldData } from "../lib/retention";
import { backfillCreators, startLaunchRecorder } from "../lib/devrep";
import { applyOverrides } from "../lib/settings";
import { trackSignals } from "../lib/shadow";
import { managePositions } from "../lib/positions";
import { notify } from "../lib/telegram";
import { listenerHealth, syncSubscriptions, watchingCount } from "./listener";

function every(ms: number, name: string, fn: () => Promise<unknown>) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      await log(name, `error: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };
  tick();
  return setInterval(tick, ms);
}

async function discoveryDue() {
  const requested = await getKv("discovery:requested");
  if (requested) {
    await db.kv.delete({ where: { key: "discovery:requested" } }).catch(() => {});
    return true;
  }
  const last = await getKv("discovery:lastRun");
  return !last || Date.now() - new Date(last).getTime() > config.discoveryIntervalMin * 60_000;
}

/**
 * Which parts of the wallet pipeline are needed right now. With copy trading off it pauses to save RPC
 * credits — except the listener keeps running while copy positions are still open (mirror exits), and
 * everything stays on if the migration strategy is set to require smart wallets.
 */
async function walletNeeds() {
  const copyOn = (await strategyMode("copy")) !== "off";
  const migrationUsesWallets = config.migrationMinSmartWallets > 0;
  const openCopy = await db.position.count({ where: { status: "OPEN", strategy: "copy" } });
  return { discovery: copyOn || migrationUsesWallets, listener: copyOn || migrationUsesWallets || openCopy > 0 };
}

async function main() {
  if (!config.heliusKey && !process.env.SOLANA_RPC_URL) {
    console.error("Set HELIUS_API_KEY (or SOLANA_RPC_URL + SOLANA_WSS_URL) in .env");
    process.exit(1);
  }
  // Dashboard settings: applied before anything runs, then re-checked every 15s (no restart needed).
  await applyOverrides().catch((e) => console.error("settings", e));
  setInterval(() => applyOverrides().catch(() => {}), 15_000);

  const modes = await allModes();
  const summary = `copy trading ${modes.copy.toUpperCase()}, migration ${modes.migration.toUpperCase()}, launch sniper ${modes.launch.toUpperCase()}`;
  await log("worker", `starting: ${summary}`);
  await notify(`🤖 Coinbit worker started — ${summary}`);
  startMigrationStrategy();
  startLaunchStrategy();
  startLaunchRecorder(); // every pump.fun launch → dev-reputation history
  every(3600_000, "creators", backfillCreators); // graduates recorded before creators were stored

  // Discovery: checked every minute, runs when due or when requested from the dashboard.
  // The wallet pipeline (discovery, vetting, live wallet listener) only runs when something needs it.
  every(60_000, "discovery", async () => {
    if ((await walletNeeds()).discovery && (await discoveryDue())) {
      await runDiscovery();
      await syncSubscriptions();
    }
  });
  every(120_000, "listener", async () => syncSubscriptions((await walletNeeds()).listener));
  // Vet more candidates' full trade history between discovery runs, so the watchlist keeps growing.
  every(config.vetIntervalMin * 60_000, "vetting", async () => {
    if (!(await walletNeeds()).discovery) return;
    const r = await vetMore();
    if (r?.vetted) await syncSubscriptions();
  });
  sweepEmptyTokenAccounts().catch((e) => log("trade", `rent sweep failed: ${(e as Error).message}`));
  every(10_000, "positions", managePositions);
  every(60_000, "shadow", trackSignals); // what every signal did afterwards, taken or skipped
  every(6 * 3600_000, "retention", pruneOldData); // logs 14d, raw wallet events 30d, untraded signals 90d
  every(30_000, "heartbeat", async () => {
    await setKv("worker:heartbeat", JSON.stringify({
        at: new Date().toISOString(),
        watching: watchingCount(),
        mode: config.mode,
        modes: await allModes(),
        canTradeLive: !!config.traderKey,
        liveFeeds: liveFeedCount(),
        ...listenerHealth(),
      }));
  });
}

process.on("unhandledRejection", (e) => console.error("unhandled", e));
main();
