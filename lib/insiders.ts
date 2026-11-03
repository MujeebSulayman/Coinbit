/**
 * Insider-dump exit: watches the top-5 wallet holders of each open position's coin (excluding the
 * curve, the pool and our own wallet). Triggers when, together, they've sold at least INSIDER_SELL_PCT
 * of their combined holdings (a coordinated exit), or when a single big holder (≥3× the watch minimum)
 * dumps that much of their own bag — the usual start of a rug. One holder taking profit doesn't count.
 */
import { PublicKey, type ParsedAccountData } from "@solana/web3.js";
import { config } from "./config";
import { bondingCurvePda, conn, PUMP_TOTAL_SUPPLY, withRetry } from "./solana";
import { stream } from "./stream";

type Holder = { account: string; owner: string; start: number; now: number; sub: number };
const watched = new Map<number, Holder[]>(); // position id → holders
const tried = new Set<number>();

export type InsiderDump = { owner: string; soldPct: number; heldPct: number; group: boolean };

async function watch(id: number, mint: string, exclude: string[], onDump: (id: number, d: InsiderDump) => void) {
  tried.add(id);
  const largest = await withRetry(() => conn().getTokenLargestAccounts(new PublicKey(mint), "confirmed"));
  const accts = largest.value.slice(0, 12);
  const infos = await conn().getMultipleParsedAccounts(accts.map((a) => a.address), { commitment: "confirmed" });
  const skip = new Set([bondingCurvePda(mint).toBase58(), ...exclude]);
  const minRaw = (config.insiderMinHoldPct / 100) * PUMP_TOTAL_SUPPLY;
  const holders: Holder[] = [];
  accts.forEach((a, i) => {
    if (holders.length >= 5) return;
    const owner = (infos.value[i]?.data as ParsedAccountData | undefined)?.parsed?.info?.owner as string | undefined;
    const ui = a.uiAmount ?? 0;
    // Real holders are normal wallets; pools, curves and vaults are program-derived (off-curve) addresses.
    if (!owner || skip.has(owner) || ui < minRaw || !PublicKey.isOnCurve(new PublicKey(owner).toBytes())) return;
    const h: Holder = { account: a.address.toBase58(), owner, start: ui, now: ui, sub: 0 };
    h.sub = stream().subscribe("accountSubscribe", [h.account, { encoding: "jsonParsed", commitment: "confirmed" }], (r) => {
      if (!config.insiderExit) return;
      const now = Number(r?.value?.data?.parsed?.info?.tokenAmount?.uiAmount ?? NaN);
      if (!Number.isFinite(now)) return;
      h.now = now;
      const soldPct = (1 - now / h.start) * 100;
      const heldPct = (h.start / PUMP_TOTAL_SUPPLY) * 100;
      if (heldPct >= config.insiderMinHoldPct * 3 && soldPct >= config.insiderSellPct) {
        return onDump(id, { owner: h.owner, soldPct, heldPct, group: false });
      }
      const start = holders.reduce((s, x) => s + x.start, 0);
      const cur = holders.reduce((s, x) => s + Math.min(x.now, x.start), 0); // buying more doesn't offset others' selling
      const groupSold = (1 - cur / start) * 100;
      if (holders.length >= 2 && groupSold >= config.insiderSellPct) {
        onDump(id, { owner: `top ${holders.length}`, soldPct: groupSold, heldPct: (start / PUMP_TOTAL_SUPPLY) * 100, group: true });
      }
    });
    holders.push(h);
  });
  watched.set(id, holders);
}

/** Starts watching holders for new open positions; stops for closed ones. */
export async function syncInsiderWatch(
  open: { id: number; mint: string; pool: string | null }[],
  ourWallet: string | null,
  onDump: (id: number, d: InsiderDump) => void,
) {
  const want = new Set(open.map((p) => p.id));
  for (const [id, hs] of watched) {
    if (want.has(id)) continue;
    for (const h of hs) stream().unsubscribe(h.sub);
    watched.delete(id);
    tried.delete(id);
  }
  if (!config.insiderExit) return;
  for (const p of open) {
    if (tried.has(p.id)) continue;
    const exclude = [p.pool, ourWallet].filter((x): x is string => !!x);
    await watch(p.id, p.mint, exclude, onDump).catch(() => {});
  }
}

export const insiderWatchCount = () => [...watched.values()].reduce((s, h) => s + h.length, 0);
