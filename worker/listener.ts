/** Real-time listener: one websocket log subscription per watched wallet. */
import { PublicKey } from "@solana/web3.js";
import { db, log } from "../lib/db";
import { onTrackedSell } from "../lib/positions";
import { evaluate } from "../lib/signals";
import { conn, feePayer, IGNORED_MINTS, isPumpCreate, sleep, solDelta, tokenDeltas } from "../lib/solana";

const subs = new Map<string, number>(); // wallet -> subscription id
const seenSigs = new Set<string>();
const queue: { sig: string; wallet: string }[] = [];
let workers = 0;
const MAX_WORKERS = 4;

function remember(sig: string) {
  seenSigs.add(sig);
  if (seenSigs.size > 20_000) {
    const first = seenSigs.values().next().value;
    if (first) seenSigs.delete(first);
  }
}

async function fetchTx(sig: string) {
  for (let i = 0; i < 5; i++) {
    const tx = await conn()
      .getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
      .catch(() => null);
    if (tx) return tx;
    await sleep(400 * (i + 1));
  }
  return null;
}

async function handle(sig: string, wallet: string) {
  const tx = await fetchTx(sig);
  if (!tx || tx.meta?.err) return;
  const created = isPumpCreate(tx.meta?.logMessages) && feePayer(tx) === wallet;
  const all = tokenDeltas(tx).filter((d) => !IGNORED_MINTS.has(d.mint));
  const mine = all.filter((d) => d.owner === wallet);
  const sol = solDelta(tx, wallet);

  const events: { mint: string; side: "BUY" | "SELL" | "CREATE"; tokenDelta: number }[] = [];
  if (created) {
    for (const m of new Set(all.map((d) => d.mint))) events.push({ mint: m, side: "CREATE", tokenDelta: 0 });
  }
  for (const d of mine) {
    if (created && events.some((e) => e.mint === d.mint)) continue;
    events.push({ mint: d.mint, side: d.delta > 0 ? "BUY" : "SELL", tokenDelta: d.delta });
  }
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

function subscribe(wallet: string) {
  const id = conn().onLogs(
    new PublicKey(wallet),
    (l) => {
      if (l.err || seenSigs.has(l.signature)) return;
      remember(l.signature);
      queue.push({ sig: l.signature, wallet });
      pump();
    },
    "confirmed",
  );
  subs.set(wallet, id);
}

/** Syncs websocket subscriptions with the current watchlist. */
export async function syncSubscriptions() {
  const watching = await db.wallet.findMany({ where: { status: "WATCHING" }, select: { address: true } });
  const want = new Set(watching.map((w) => w.address));
  let added = 0;
  let removed = 0;
  for (const [w, id] of subs) {
    if (!want.has(w)) {
      await conn().removeOnLogsListener(id).catch(() => {});
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
  if (added || removed) await log("listener", `watching ${subs.size} wallets (+${added} / -${removed})`);
  return subs.size;
}

export const watchingCount = () => subs.size;
