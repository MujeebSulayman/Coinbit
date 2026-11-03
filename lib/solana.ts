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

let _conn: Connection | null = null;
export function conn(): Connection {
  if (!_conn) {
    _conn = new Connection(config.rpcUrl, { wsEndpoint: config.wssUrl, commitment: "confirmed" });
  }
  return _conn;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry wrapper for flaky RPC / 429s. */
export async function withRetry<T>(fn: () => Promise<T>, tries = 4, baseMs = 500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
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
  priceSol: number; // SOL per 1 whole token
};

export function decodeBondingCurve(data: Buffer): BondingCurve | null {
  if (data.length < 49) return null;
  const vTok = data.readBigUInt64LE(8);
  const vSol = data.readBigUInt64LE(16);
  const rTok = data.readBigUInt64LE(24);
  const rSol = data.readBigUInt64LE(32);
  const supply = data.readBigUInt64LE(40);
  const complete = data[48] === 1;
  const priceSol =
    vTok > 0n ? Number(vSol) / 1e9 / (Number(vTok) / 10 ** PUMP_DECIMALS) : 0;
  return {
    virtualTokenReserves: vTok,
    virtualSolReserves: vSol,
    realTokenReserves: rTok,
    realSolReserves: rSol,
    tokenTotalSupply: supply,
    complete,
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

export async function getParsedTxs(signatures: string[]): Promise<(ParsedTransactionWithMeta | null)[]> {
  const out: (ParsedTransactionWithMeta | null)[] = [];
  for (let i = 0; i < signatures.length; i += 25) {
    const chunk = signatures.slice(i, i + 25);
    const res = await withRetry(() =>
      conn().getParsedTransactions(chunk, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }),
    );
    out.push(...res);
  }
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
