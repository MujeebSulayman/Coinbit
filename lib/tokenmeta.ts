/**
 * A coin's name and symbol, straight from the chain. DexScreener only lists a coin once it trades on a
 * DEX, so coins still on the bonding curve had no name and showed up as address fragments ("3U1SJBJn").
 *
 * pump.fun coins carry their metadata in one of two places:
 *  - a Metaplex metadata account (PDA ["metadata", program, mint]), for classic SPL mints
 *  - the Token-2022 TokenMetadata extension inside the mint account itself, for newer mints
 * Both are read in one getMultipleAccounts call per batch.
 */
import { PublicKey } from "@solana/web3.js";
import { conn } from "./solana";

const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOKEN_METADATA_EXT = 19; // Token-2022 extension type
const cache = new Map<string, { name: string; symbol: string } | null>();

const metadataPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX)[0];

/** Reads a borsh string (u32 length + bytes) at `o`; returns it (trailing NULs trimmed) and the next offset. */
function borshString(b: Buffer, o: number): [string, number] {
  if (o + 4 > b.length) return ["", b.length];
  const len = b.readUInt32LE(o);
  const end = Math.min(b.length, o + 4 + len);
  return [b.subarray(o + 4, end).toString("utf8").replace(/\0+$/g, "").trim(), end];
}

export function parseMetaplex(data: Buffer) {
  if (data.length < 1 + 32 + 32 + 8) return null;
  const [name, o] = borshString(data, 1 + 32 + 32);
  const [symbol] = borshString(data, o);
  return name || symbol ? { name, symbol } : null;
}

/** Token-2022 mint: 82-byte base, padding to 165, account-type byte, then TLV extensions. */
export function parseToken2022Metadata(data: Buffer) {
  let o = 166;
  while (o + 4 <= data.length) {
    const type = data.readUInt16LE(o);
    const len = data.readUInt16LE(o + 2);
    const v = o + 4;
    if (type === TOKEN_METADATA_EXT) {
      const [name, o2] = borshString(data, v + 32 + 32); // after update authority and mint
      const [symbol] = borshString(data, o2);
      return name || symbol ? { name, symbol } : null;
    }
    if (type === 0 && len === 0) break; // uninitialized
    o = v + len;
  }
  return null;
}

/** Name and symbol per mint (missing when the chain has none). Cached for the process lifetime. */
export async function tokenNames(mints: string[]): Promise<Map<string, { name: string; symbol: string }>> {
  const out = new Map<string, { name: string; symbol: string }>();
  const todo = [...new Set(mints)].filter((m) => {
    const c = cache.get(m);
    if (c) out.set(m, c);
    return !cache.has(m);
  });
  for (let i = 0; i < todo.length; i += 50) {
    const chunk = todo.slice(i, i + 50);
    const keys = chunk.flatMap((m) => {
      const mint = new PublicKey(m);
      return [metadataPda(mint), mint];
    });
    const infos = await conn().getMultipleAccountsInfo(keys);
    chunk.forEach((m, j) => {
      const meta = infos[j * 2], mintAcct = infos[j * 2 + 1];
      const r = (meta && parseMetaplex(meta.data as Buffer)) || (mintAcct && mintAcct.data.length > 166 ? parseToken2022Metadata(mintAcct.data as Buffer) : null);
      cache.set(m, r ?? null);
      if (r) out.set(m, r);
    });
  }
  return out;
}
