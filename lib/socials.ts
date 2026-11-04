/**
 * Social links a coin lists in its metadata (X / Telegram / website). In a study of 833k pump.fun
 * launches, coins listing all three graduated ~17× more often than coins listing none; we record the
 * count on every migration signal so the Performance page can show whether it predicts returns too.
 *
 * Source: the metadata JSON the mint points to: Token-2022 metadata extension (current pump.fun coins)
 * or the Metaplex metadata account (older coins). ipfs.io no longer serves files directly, so IPFS
 * links are fetched through gateways that do.
 */
import { PublicKey, type ParsedAccountData } from "@solana/web3.js";
import { conn, withRetry } from "./solana";

const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const GATEWAYS = ["https://ipfs.filebase.io/ipfs/", "https://gateway.pinata.cloud/ipfs/", "https://4everland.io/ipfs/"];

export type Socials = { count: number; kinds: string[] };

/** Reads a borsh string (u32 length + bytes), trimming the null padding Metaplex uses. */
function borshString(buf: Buffer, at: number): [string, number] {
  const len = buf.readUInt32LE(at);
  return [buf.subarray(at + 4, at + 4 + len).toString("utf8").replace(/\0+$/, ""), at + 4 + len];
}

async function metadataUri(mint: string): Promise<string | null> {
  const key = new PublicKey(mint);
  const info = await withRetry(() => conn().getParsedAccountInfo(key, "confirmed"));
  const exts = ((info.value?.data as ParsedAccountData | undefined)?.parsed?.info?.extensions ?? []) as {
    extension: string;
    state?: { uri?: string };
  }[];
  const uri = exts.find((e) => e.extension === "tokenMetadata")?.state?.uri;
  if (uri) return uri;
  // Classic SPL mint: Metaplex metadata = key(1) · update authority(32) · mint(32) · name · symbol · uri
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), key.toBuffer()], METAPLEX);
  const acct = await withRetry(() => conn().getAccountInfo(pda, "confirmed"));
  if (!acct) return null;
  let at = 65;
  [, at] = borshString(acct.data, at); // name
  [, at] = borshString(acct.data, at); // symbol
  return borshString(acct.data, at)[0] || null;
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r?.ok) return null;
  return (await r.json().catch(() => null)) as Record<string, unknown> | null;
}

async function metadataJson(uri: string) {
  const cid = uri.match(/\/ipfs\/([A-Za-z0-9]+)/)?.[1] ?? (uri.startsWith("ipfs://") ? uri.slice(7) : null);
  if (!cid) return fetchJson(uri);
  for (const g of GATEWAYS) {
    const j = await fetchJson(g + cid);
    if (j) return j;
  }
  return null;
}

const isLink = (v: unknown) => typeof v === "string" && /^(https?:\/\/|t\.me\/|@)\S{3,}/i.test(v.trim());

/** Which of X / Telegram / website the coin lists. Null when the metadata can't be read. */
export async function socialLinks(mint: string): Promise<Socials | null> {
  const uri = await metadataUri(mint).catch(() => null);
  if (!uri) return null;
  const j = await metadataJson(uri);
  if (!j) return null;
  const ext = (j.extensions ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (isLink(j[k]) ? j[k] : isLink(ext[k]) ? ext[k] : null);
  const kinds = [
    pick("twitter") ? "X" : null,
    pick("telegram") ? "Telegram" : null,
    pick("website") ? "website" : null,
  ].filter((x): x is string => !!x);
  return { count: kinds.length, kinds };
}
