import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
  type ConfirmedSignatureInfo,
} from "@solana/web3.js";
import { config } from "./config";

export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const WSOL = "So11111111111111111111111111111111111111112";
export const IGNORED_MINTS = new Set([
  WSOL,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);
export const PUMP_DECIMALS = 6;
export const PUMP_TOTAL_SUPPLY = 1_000_000_000;
const INITIAL_REAL_TOKEN_RESERVES = 793_100_000 * 10 ** 6; // raw units sold along the curve before graduation

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Token bucket shared by every HTTP RPC call, so bursts never exceed the provider's per-second cap. */
function rateLimitedFetch(maxRps: number): typeof fetch {
  let tokens = maxRps;
  let last = Date.now();
  const waiters: (() => void)[] = [];
  const refill = () => {
    const now = Date.now();
    tokens = Math.min(maxRps, tokens + ((now - last) / 1000) * maxRps);
    last = now;
    while (tokens >= 1 && waiters.length) {
      tokens -= 1;
      waiters.shift()!();
    }
    if (waiters.length) setTimeout(refill, Math.ceil(1000 / maxRps));
  };
  const take = () =>
    new Promise<void>((resolve) => {
      waiters.push(resolve);
      if (waiters.length === 1) refill();
    });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    await take();
    return fetch(input, init);
  }) as typeof fetch;
}

const limitedFetch = rateLimitedFetch(config.rpcMaxRps);
const rpcUrls = [config.rpcUrl, ...config.rpcFallbackUrls];
const _conns: Connection[] = [];
let active = 0;

function connAt(i: number): Connection {
  _conns[i] ??= new Connection(rpcUrls[i], { commitment: "confirmed", fetch: limitedFetch });
  return _conns[i];
}

/** The active RPC connection. Rotates to a fallback endpoint when the active one keeps failing. */
export function conn(): Connection {
  return connAt(active);
}

/** Every configured RPC, for broadcasting signed transactions. */
export function allConns(): Connection[] {
  return rpcUrls.map((_, i) => connAt(i));
}

let failures = 0;
function noteFailure() {
  if (rpcUrls.length < 2) return;
  if (++failures >= 3) {
    failures = 0;
    active = (active + 1) % rpcUrls.length;
    console.warn(`[rpc] switching to endpoint #${active + 1} of ${rpcUrls.length}`);
  }
}

/** Retry wrapper for flaky RPC / 429s. Repeated failures rotate to the next RPC endpoint. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 4, baseMs = 500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fn();
      failures = 0;
      return r;
    } catch (e) {
      last = e;
      noteFailure();
      await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
}

const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/** A PumpSwap pool's WSOL vault (its associated token account): its balance is the pool's real SOL. */
export function poolSolVault(pool: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(pool).toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(WSOL).toBuffer()],
    ATA_PROGRAM,
  )[0];
}

export function bondingCurvePda(mint: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
    PUMP_PROGRAM,
  )[0];
}

export type BondingCurve = {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: string | null; // present on current-layout curves (offset 49)
  priceSol: number; // SOL per 1 whole token
  progressPct: number; // share of the sellable supply already bought off the curve
};

export function decodeBondingCurve(data: Buffer): BondingCurve | null {
  if (data.length < 49) return null;
  const vTok = data.readBigUInt64LE(8);
  const vSol = data.readBigUInt64LE(16);
  const rTok = data.readBigUInt64LE(24);
  const rSol = data.readBigUInt64LE(32);
  const supply = data.readBigUInt64LE(40);
  const complete = data[48] === 1;
  const creator = data.length >= 81 ? new PublicKey(data.subarray(49, 81)).toBase58() : null;
  const priceSol =
    vTok > 0n ? Number(vSol) / 1e9 / (Number(vTok) / 10 ** PUMP_DECIMALS) : 0;
  return {
    virtualTokenReserves: vTok,
    virtualSolReserves: vSol,
    realTokenReserves: rTok,
    realSolReserves: rSol,
    tokenTotalSupply: supply,
    complete,
    creator,
    progressPct: complete ? 100 : Math.max(0, Math.min(100, (1 - Number(rTok) / INITIAL_REAL_TOKEN_RESERVES) * 100)),
    priceSol,
  };
}

export async function getBondingCurves(mints: string[]): Promise<Map<string, BondingCurve>> {
  const out = new Map<string, BondingCurve>();
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    const infos = await withRetry(() =>
      conn().getMultipleAccountsInfo(chunk.map((m) => bondingCurvePda(m))),
    );
    infos.forEach((info, j) => {
      if (!info || !info.owner.equals(PUMP_PROGRAM)) return;
      const bc = decodeBondingCurve(info.data as Buffer);
      if (bc) out.set(chunk[j], bc);
    });
  }
  return out;
}

/** Walks an address's history back to its very first signatures (oldest first). */
export async function oldestSignatures(
  address: PublicKey,
  maxPages = 25,
): Promise<{ sigs: ConfirmedSignatureInfo[]; reachedStart: boolean }> {
  let before: string | undefined;
  let lastPage: ConfirmedSignatureInfo[] = [];
  let prevPage: ConfirmedSignatureInfo[] = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await withRetry(() =>
      conn().getSignaturesForAddress(address, { before, limit: 1000 }),
    );
    if (res.length === 0) break;
    prevPage = lastPage;
    lastPage = res;
    before = res[res.length - 1].signature;
    if (res.length < 1000) {
      // Merge the last two pages so we always have enough of the earliest txs.
      return { sigs: [...prevPage, ...lastPage].reverse(), reachedStart: true };
    }
  }
  return { sigs: [...prevPage, ...lastPage].reverse(), reachedStart: false };
}

/**
 * Fetches transactions one by one with limited concurrency. Batched requests fail as a whole
 * when the RPC rate-limits any part of the batch, so single requests with their own retries are more reliable.
 */
export async function getParsedTxs(signatures: string[], concurrency = 4): Promise<(ParsedTransactionWithMeta | null)[]> {
  const out: (ParsedTransactionWithMeta | null)[] = new Array(signatures.length).fill(null);
  let next = 0;
  const run = async () => {
    while (next < signatures.length) {
      const i = next++;
      out[i] = await withRetry(() =>
        conn().getParsedTransaction(signatures[i], { maxSupportedTransactionVersion: 1, commitment: "confirmed" }),
      5).catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, run));
  return out;
}

export type TokenDelta = { owner: string; mint: string; delta: number };

/** Net token balance change per (owner, mint) in a transaction. */
export function tokenDeltas(tx: ParsedTransactionWithMeta): TokenDelta[] {
  const meta = tx.meta;
  if (!meta) return [];
  const map = new Map<string, TokenDelta>();
  const add = (owner: string | undefined, mint: string, amt: number) => {
    if (!owner) return;
    const k = `${owner}:${mint}`;
    const cur = map.get(k) ?? { owner, mint, delta: 0 };
    cur.delta += amt;
    map.set(k, cur);
  };
  for (const b of meta.preTokenBalances ?? []) add(b.owner, b.mint, -(b.uiTokenAmount.uiAmount ?? 0));
  for (const b of meta.postTokenBalances ?? []) add(b.owner, b.mint, b.uiTokenAmount.uiAmount ?? 0);
  return [...map.values()].filter((d) => Math.abs(d.delta) > 1e-9);
}

/** Native SOL change (in SOL) for an account in a tx, including fees. */
export function solDelta(tx: ParsedTransactionWithMeta, owner: string): number {
  const meta = tx.meta;
  if (!meta) return 0;
  const keys = tx.transaction.message.accountKeys;
  const idx = keys.findIndex((k) => k.pubkey.toBase58() === owner);
  if (idx < 0) return 0;
  return (meta.postBalances[idx] - meta.preBalances[idx]) / 1e9;
}

export function feePayer(tx: ParsedTransactionWithMeta): string {
  return tx.transaction.message.accountKeys[0].pubkey.toBase58();
}

/** True if the tx contains a pump.fun Create instruction. */
export function isPumpCreate(logs: string[] | null | undefined): boolean {
  if (!logs) return false;
  const invoked = logs.some((l) => l.includes(PUMP_PROGRAM.toBase58()));
  return invoked && logs.some((l) => /Instruction: Create(V2)?$/.test(l));
}
