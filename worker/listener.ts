/**
 * Real-time listener for watched wallets. Two sources, deduplicated by signature:
 *  1. RPC websocket logsSubscribe per wallet (works with any provider, needs one tx fetch per event).
 *  2. PumpPortal: free instant launcher creates; with PUMPPORTAL_API_KEY, parsed buys/sells (no fetch).
 */
import { PublicKey } from "@solana/web3.js";
import { db, log } from "../lib/db";
import { onTrackedSell } from "../lib/positions";
import { type PortalTrade, portalEnabledForTrades, portalHealthy, setPortalAccounts, startPortal } from "../lib/pumpportal";
import { evaluate } from "../lib/signals";
import { conn, feePayer, IGNORED_MINTS, isPumpCreate, sleep, solDelta, tokenDeltas } from "../lib/solana";
import { stream } from "../lib/stream";

const subs = new Map<string, number>(); // wallet -> stream subscription id
const watched = new Set<string>();
const seenSigs = new Set<string>();
const queue: { sig: string; wallet: string }[] = [];
let workers = 0;
const MAX_WORKERS = 4;

type Ev = { mint: string; side: "BUY" | "SELL" | "CREATE"; tokenDelta: number };

/** Returns false if we've already handled this signature. */
function claim(sig: string) {
  if (seenSigs.has(sig)) return false;
  seenSigs.add(sig);
  if (seenSigs.size > 20_000) {
    const first = seenSigs.values().next().value;
    if (first) seenSigs.delete(first);
  }
  return true;
}

async function fetchTx(sig: string) {
  // First try immediately: at "confirmed" the tx is usually already queryable.
  for (let i = 0; i < 6; i++) {
    const tx = await conn()
      .getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" })
      .catch(() => null);
    if (tx) return tx;
    await sleep(250 * (i + 1));
  }
  return null;
}

async function record(sig: string, wallet: string, events: Ev[], sol: number) {
  if (events.length === 0) return;
  await db.wallet.updateMany({ where: { address: wallet }, data: { lastActivity: new Date() } });
  for (const e of events) {
    try {
      await db.walletEvent.create({
        data: { wallet, mint: e.mint, side: e.side, tokenDelta: e.tokenDelta, solDelta: sol, signature: sig },
      });
    } catch {
      continue; // duplicate
    }
    if (e.side === "SELL") await onTrackedSell(wallet, e.mint);
    else await evaluate(e.mint, { wallet, kind: e.side });
  }
}

async function handle(sig: string, wallet: string) {
  const tx = await fetchTx(sig);
  if (!tx || tx.meta?.err) return;
  const created = isPumpCreate(tx.meta?.logMessages) && feePayer(tx) === wallet;
  const all = tokenDeltas(tx).filter((d) => !IGNORED_MINTS.has(d.mint));
  const mine = all.filter((d) => d.owner === wallet);

  const events: Ev[] = [];
  if (created) {
    for (const m of new Set(all.map((d) => d.mint))) events.push({ mint: m, side: "CREATE", tokenDelta: 0 });
  }
  for (const d of mine) {
    if (created && events.some((e) => e.mint === d.mint)) continue;
    events.push({ mint: d.mint, side: d.delta > 0 ? "BUY" : "SELL", tokenDelta: d.delta });
  }
  await record(sig, wallet, events, solDelta(tx, wallet));
}

function pump() {
  while (workers < MAX_WORKERS && queue.length) {
    const job = queue.shift()!;
    workers++;
    handle(job.sig, job.wallet)
      .catch((e) => log("listener", `handle ${job.sig} failed: ${(e as Error).message}`))
      .finally(() => {
        workers--;
        pump();
      });
  }
}

let logsUnsupported = false; // some providers (e.g. Infura) have no logsSubscribe

function subscribe(wallet: string) {
  if (logsUnsupported) return subscribeAccount(wallet);
  const id = stream().subscribe(
    "logsSubscribe",
    [{ mentions: [wallet] }, { commitment: "confirmed" }],
    (r) => {
      const v = r?.value;
      if (!v || v.err || !claim(v.signature)) return;
      queue.push({ sig: v.signature, wallet });
      pump();
    },
    (msg) => {
      if (!logsUnsupported) {
        logsUnsupported = true;
        log("listener", `provider has no logsSubscribe (${msg}); watching wallet balances instead`);
      }
      if (subs.get(wallet) === id) subscribeAccount(wallet);
    },
  );
  subs.set(wallet, id);
}

/* Fallback: every trade changes the wallet's SOL balance, so a balance notification means
   "something happened" — then fetch the wallet's newest signatures and handle the new ones. */
const lastSig = new Map<string, string>();
const polling = new Set<string>();
const dirty = new Set<string>(); // notified while a poll was running → poll again after

async function pollWallet(wallet: string) {
  if (polling.has(wallet)) {
    dirty.add(wallet);
    return;
  }
  polling.add(wallet);
  try {
    const until = lastSig.get(wallet);
    const sigs = await conn().getSignaturesForAddress(new PublicKey(wallet), { limit: 10, until }, "confirmed");
    if (sigs.length) lastSig.set(wallet, sigs[0].signature);
    if (!until) return; // first poll only sets the baseline
    for (const s of sigs.reverse()) {
      if (s.err || !claim(s.signature)) continue;
      queue.push({ sig: s.signature, wallet });
    }
    pump();
  } catch (e) {
    await log("listener", `poll ${wallet} failed: ${(e as Error).message}`);
  } finally {
    polling.delete(wallet);
    if (dirty.delete(wallet)) pollWallet(wallet);
  }
}

function subscribeAccount(wallet: string) {
  pollWallet(wallet); // baseline
  const id = stream().subscribe("accountSubscribe", [wallet, { encoding: "jsonParsed", commitment: "confirmed" }], () =>
    setTimeout(() => pollWallet(wallet), 300),
  );
  subs.set(wallet, id);
}

/* ---------- PumpPortal fast paths ---------- */

function onPortalCreate(m: PortalTrade) {
  if (!watched.has(m.traderPublicKey) || !claim(m.signature)) return;
  const events: Ev[] = [{ mint: m.mint, side: "CREATE", tokenDelta: 0 }];
  // Give the RPC a moment to see the new bonding curve before pricing it.
  sleep(1500)
    .then(() => record(m.signature, m.traderPublicKey, events, -(m.solAmount ?? 0)))
    .catch((e) => log("listener", `portal create ${m.signature} failed: ${(e as Error).message}`));
}

function onPortalTrade(m: PortalTrade) {
  if (!watched.has(m.traderPublicKey) || !claim(m.signature)) return;
  const buy = m.txType === "buy";
  const tokens = m.tokenAmount ?? 0;
  const sol = m.solAmount ?? 0;
  const events: Ev[] = [{ mint: m.mint, side: buy ? "BUY" : "SELL", tokenDelta: buy ? tokens : -tokens }];
  record(m.signature, m.traderPublicKey, events, buy ? -sol : sol).catch((e) =>
    log("listener", `portal trade ${m.signature} failed: ${(e as Error).message}`),
  );
}

/** Syncs subscriptions with the current watchlist. */
export async function syncSubscriptions() {
  startPortal({ onCreate: onPortalCreate, onTrade: onPortalTrade });
  const rows = await db.wallet.findMany({ where: { status: "WATCHING" }, select: { address: true } });
  const want = new Set(rows.map((w) => w.address));
  let added = 0;
  let removed = 0;
  for (const [w, id] of subs) {
    if (!want.has(w)) {
      stream().unsubscribe(id);
      subs.delete(w);
      removed++;
    }
  }
  for (const w of want) {
    if (!subs.has(w)) {
      subscribe(w);
      added++;
    }
  }
  watched.clear();
  for (const w of want) watched.add(w);
  setPortalAccounts(want);
  if (added || removed) {
    const via = portalEnabledForTrades() ? "RPC + PumpPortal trades" : "RPC (+ PumpPortal creates)";
    await log("listener", `watching ${subs.size} wallets via ${via} (+${added} / -${removed})`);
  }
  return subs.size;
}

export const watchingCount = () => subs.size;
export const listenerHealth = () => ({ rpc: stream().healthy, portal: portalHealthy(), reconnects: stream().reconnects });
