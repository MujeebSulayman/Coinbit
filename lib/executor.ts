/**
 * Executor — paper trading by default, real Jupiter swaps in live mode.
 * Jupiter routes pump.fun coins both on the bonding curve and after migration.
 *
 * Live fills are read back from the confirmed transaction (real tokens received / SOL spent),
 * never from the quote, and sells are clamped to the wallet's actual token balance.
 *
 * Landing: the signed swap is broadcast to every configured RPC and, when JITO_TIP_LAMPORTS > 0,
 * also sent to Jito as a bundle [swap, tip]. Bundles are atomic, so the tip is only paid if Jito
 * is the path that lands the swap. Empty token accounts are closed after exits to recover rent.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config";
import { log } from "./db";
import { jupBuyQuote } from "./market";
import { sleep, solDelta, tokenDeltas, WSOL } from "./solana";

const JUP = "https://lite-api.jup.ag/swap/v1";
const PORTAL_TRADE = "https://pumpportal.fun/api/trade-local"; // builds a pump.fun / PumpSwap tx for us to sign (0.5% fee)
const PAPER_FEE_PCT = 1; // approximates pool/curve fees so paper PnL isn't flattering
const SELL_ATTEMPTS = 3;
const MAX_SLIPPAGE_BPS = 5000;
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const FALLBACK_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
];

let _kp: Keypair | null = null;
function trader(): Keypair {
  if (!_kp) {
    if (!config.traderKey) throw new Error("TRADER_PRIVATE_KEY missing (required for live mode)");
    _kp = Keypair.fromSecretKey(bs58.decode(config.traderKey));
  }
  return _kp;
}

/** Our trading wallet's address, or null when no key is configured (paper only). */
export function traderAddress(): string | null {
  try {
    return config.traderKey ? trader().publicKey.toBase58() : null;
  } catch {
    return null;
  }
}

/** Trade-path connections bypass the shared RPC rate limiter so exits never queue behind discovery. */
let _fast: Connection[] | null = null;
function fastConns(): Connection[] {
  _fast ??= [config.rpcUrl, ...config.rpcFallbackUrls].map((u) => new Connection(u, { commitment: "confirmed" }));
  return _fast;
}
const fast = () => fastConns()[0];

/** empty = the wallet held none of the token, so there was nothing to sell. */
export type Fill = { signature: string | null; tokens: number; sol: number; empty?: boolean };

/* ---------------- Jito ---------------- */

let tipAccounts: string[] | null = null;
async function tipAccount(): Promise<PublicKey> {
  if (!tipAccounts) {
    try {
      const r = await fetch(`${config.jitoUrl}/api/v1/bundles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTipAccounts", params: [] }),
        signal: AbortSignal.timeout(3000),
      });
      const j = (await r.json()) as { result?: string[] };
      tipAccounts = j.result?.length ? j.result : FALLBACK_TIP_ACCOUNTS;
    } catch {
      tipAccounts = FALLBACK_TIP_ACCOUNTS;
    }
  }
  return new PublicKey(tipAccounts[Math.floor(Math.random() * tipAccounts.length)]);
}

async function sendJitoBundle(swap: VersionedTransaction) {
  if (config.jitoTipLamports <= 0) return;
  const kp = trader();
  const msg = new TransactionMessage({
    payerKey: kp.publicKey,
    recentBlockhash: swap.message.recentBlockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: await tipAccount(), lamports: config.jitoTipLamports })],
  }).compileToV0Message();
  const tip = new VersionedTransaction(msg);
  tip.sign([kp]);
  const b64 = (t: VersionedTransaction) => Buffer.from(t.serialize()).toString("base64");
  fetch(`${config.jitoUrl}/api/v1/bundles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [[b64(swap), b64(tip)], { encoding: "base64" }] }),
  }).catch(() => {});
}

/* ---------------- sending ---------------- */

function broadcast(raw: Uint8Array) {
  for (const c of fastConns()) c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
}

/** Sends a signed tx on every path, re-broadcasting until it confirms or its blockhash expires. */
async function sendAndConfirm(tx: VersionedTransaction | Transaction, lastValidBlockHeight: number): Promise<string> {
  const raw = tx.serialize();
  if (tx instanceof VersionedTransaction) await sendJitoBundle(tx).catch(() => {});
  const sig = await fast().sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  broadcast(raw);
  for (;;) {
    const { value } = await fast().getSignatureStatuses([sig]);
    const st = value[0];
    if (st?.err) throw new Error(`tx failed on-chain: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    if ((await fast().getBlockHeight("confirmed")) > lastValidBlockHeight) {
      // One last look: it may have landed right at the edge.
      const final = (await fast().getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      if (final && !final.err && final.confirmationStatus) return sig;
      throw new Error(`tx expired without confirming (${sig})`);
    }
    broadcast(raw);
    await sleep(1500);
  }
}

/** Actual token and SOL change for our wallet in a confirmed tx. */
async function readFill(sig: string, mint: string): Promise<{ tokens: number; sol: number }> {
  const owner = trader().publicKey.toBase58();
  for (let i = 0; i < 8; i++) {
    const tx = await fast()
      .getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" })
      .catch(() => null);
    if (tx) {
      const tokens = tokenDeltas(tx).find((d) => d.owner === owner && d.mint === mint)?.delta ?? 0;
      return { tokens, sol: solDelta(tx, owner) };
    }
    await sleep(750);
  }
  throw new Error(`confirmed but could not read fill for ${sig}`);
}

async function swap(inputMint: string, outputMint: string, amountRaw: bigint, slippageBps: number, priorityFee: number) {
  const user = trader().publicKey.toBase58();
  const qRes = await fetch(
    `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`,
  );
  if (!qRes.ok) throw new Error(`jupiter quote ${qRes.status}: ${await qRes.text()}`);
  const quote = await qRes.json();

  const sRes = await fetch(`${JUP}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: user,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: priorityFee,
    }),
  });
  if (!sRes.ok) throw new Error(`jupiter swap ${sRes.status}: ${await sRes.text()}`);
  const { swapTransaction, lastValidBlockHeight } = (await sRes.json()) as { swapTransaction: string; lastValidBlockHeight: number };

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([trader()]);
  return sendAndConfirm(tx, lastValidBlockHeight);
}

/* ---------------- fast path (launch sniper) ---------------- */

/** Block height, refreshed in the background so the fast path never waits on it. */
let height = { v: 0, at: 0 };
async function blockHeight() {
  if (Date.now() - height.at > 3000) {
    const refresh = fast()
      .getBlockHeight("confirmed")
      .then((v) => (height = { v, at: Date.now() }));
    if (!height.v) await refresh; // first call only
  }
  return height.v;
}

/**
 * PumpPortal's Local Transaction API returns a ready-made pump.fun (or PumpSwap) transaction, so a
 * buy costs one HTTP round-trip before signing, instead of Jupiter's quote + swap (which may not even
 * route a coin that is seconds old). We sign locally and send it on every path like any other trade.
 */
async function portalSwap(body: Record<string, unknown>) {
  return sendAndConfirm(await portalTx(body), (await blockHeight()) + 150);
}

async function portalTx(body: Record<string, unknown>) {
  const res = await fetch(PORTAL_TRADE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey: trader().publicKey.toBase58(), ...body }),
    signal: AbortSignal.timeout(5000),
  });
  if (res.status !== 200) throw new Error(`pumpportal ${res.status}: ${await res.text()}`);
  const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  tx.sign([trader()]);
  return tx;
}

export type FastFill = Fill & { slot: number | null };

/**
 * Launch-sniper buy, in two steps so the caller can check the coin while PumpPortal builds the
 * transaction: `prepareBuyFast` starts the request right away; `send()` signs and broadcasts it.
 * Never calling `send()` means nothing is sent (the built transaction is just dropped).
 */
export function prepareBuyFast(mint: string, sizeSol: number) {
  const built = portalTx({
    action: "buy",
    mint,
    amount: sizeSol,
    denominatedInSol: "true",
    slippage: config.launchSlippagePct,
    priorityFee: config.launchPriorityFeeSol,
    pool: "pump",
  });
  built.catch(() => {}); // a dropped build must not surface as an unhandled rejection
  return {
    send: async (): Promise<FastFill> => {
      const sig = await sendAndConfirm(await built, (await blockHeight()) + 150); // a blockhash stays valid ~150 blocks
      const [fill, st] = await Promise.all([readFill(sig, mint), fast().getSignatureStatuses([sig])]);
      if (fill.tokens <= 0) throw new Error(`buy ${sig} confirmed but received no tokens`);
      return { signature: sig, tokens: fill.tokens, sol: -fill.sol, slot: st.value[0]?.slot ?? null };
    },
  };
}

/** Reads one account on the trade-path connection (bypasses the shared RPC rate limiter). */
export const readAccountFast = (key: PublicKey) => fast().getAccountInfo(key, "confirmed");

/** Slot of a confirmed transaction (e.g. a coin's create tx), or null. */
export async function txSlot(sig: string): Promise<number | null> {
  const st = await fast().getSignatureStatuses([sig], { searchTransactionHistory: true }).catch(() => null);
  return st?.value[0]?.slot ?? null;
}

/* ---------------- token accounts ---------------- */

type TokenAcct = { pubkey: PublicKey; program: PublicKey; raw: bigint; decimals: number; lamports: number };

async function tokenAccounts(mint?: string): Promise<TokenAcct[]> {
  const owner = trader().publicKey;
  const filters = mint ? [{ mint: new PublicKey(mint) }] : [{ programId: TOKEN_PROGRAM }, { programId: TOKEN_2022_PROGRAM }];
  const out: TokenAcct[] = [];
  for (const f of filters) {
    const res = await fast().getParsedTokenAccountsByOwner(owner, f, "confirmed");
    for (const a of res.value) {
      const amt = a.account.data.parsed.info.tokenAmount;
      out.push({ pubkey: a.pubkey, program: a.account.owner, raw: BigInt(amt.amount), decimals: amt.decimals, lamports: a.account.lamports });
    }
  }
  return out;
}

/** Closes empty token accounts (rent goes back to us). Returns SOL recovered. */
async function closeEmpty(accts: TokenAcct[]): Promise<number> {
  const empty = accts.filter((a) => a.raw === 0n);
  let recovered = 0;
  const owner = trader().publicKey;
  for (let i = 0; i < empty.length; i += 8) {
    const batch = empty.slice(i, i + 8);
    const tx = new Transaction();
    for (const a of batch) {
      tx.add(
        new TransactionInstruction({
          programId: a.program,
          keys: [
            { pubkey: a.pubkey, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: true, isWritable: false },
          ],
          data: Buffer.from([9]), // CloseAccount (same index in SPL Token and Token-2022)
        }),
      );
    }
    const { blockhash, lastValidBlockHeight } = await fast().getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = owner;
    tx.sign(trader());
    try {
      await sendAndConfirm(tx, lastValidBlockHeight);
      recovered += batch.reduce((s, a) => s + a.lamports, 0) / 1e9;
    } catch (e) {
      await log("trade", `closing ${batch.length} empty token accounts failed: ${(e as Error).message}`);
    }
  }
  return recovered;
}

/** Live mode, on worker start: closes every leftover empty token account in the trading wallet. */
export async function sweepEmptyTokenAccounts() {
  if (!config.traderKey) return;
  const sol = await closeEmpty(await tokenAccounts());
  if (sol > 0) await log("trade", `recovered ${sol.toFixed(4)} SOL rent from empty token accounts`);
}

/* ---------------- buy / sell ---------------- */

export type ExecMode = "paper" | "live";

/**
 * Paper buys fill at what you could actually get right now: `paperTokens` when the caller computed an
 * executable fill itself (the launch sniper, from the bonding curve), otherwise a fresh Jupiter buy
 * quote. The passed-in price is only a fallback; it can be minutes old (that made paper losses look
 * worse than live ones: see the 2026-11 trade review).
 */
export async function buy(mint: string, sizeSol: number, priceSol: number, mode: ExecMode, paperTokens?: number): Promise<Fill> {
  if (mode === "paper") {
    if (paperTokens && paperTokens > 0) return { signature: null, tokens: paperTokens, sol: sizeSol };
    const q = await jupBuyQuote(mint, sizeSol).catch(() => null);
    const net = sizeSol * (1 - PAPER_FEE_PCT / 100);
    return { signature: null, tokens: q ? q.tokens * (1 - PAPER_FEE_PCT / 100) : priceSol > 0 ? net / priceSol : 0, sol: sizeSol };
  }
  // Buys get one attempt: if the price ran away, chasing it is worse than missing it.
  const sig = await swap(WSOL, mint, BigInt(Math.floor(sizeSol * 1e9)), config.slippageBps, config.priorityFeeLamports);
  const fill = await readFill(sig, mint);
  if (fill.tokens <= 0) throw new Error(`buy ${sig} confirmed but received no tokens`);
  // SOL spent includes network fees and token-account rent (recovered when the position closes).
  return { signature: sig, tokens: fill.tokens, sol: -fill.sol };
}

/** Sells `tokens` (or everything held when `all`), retrying with wider slippage and higher fees.
 *  On a full exit the emptied token account is closed and its rent added to the proceeds. */
export async function sell(mint: string, tokens: number, priceSol: number, all: boolean, mode: ExecMode, viaPortal = false): Promise<Fill> {
  if (mode === "paper") {
    return { signature: null, tokens, sol: tokens * priceSol * (1 - PAPER_FEE_PCT / 100) };
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < SELL_ATTEMPTS; attempt++) {
    const accts = await tokenAccounts(mint);
    const raw = accts.reduce((s, a) => s + a.raw, 0n);
    if (raw === 0n) {
      const rent = await closeEmpty(accts);
      return { signature: null, tokens: 0, sol: rent, empty: true };
    }
    const decimals = accts.find((a) => a.raw > 0n)?.decimals ?? 6;
    const want = BigInt(Math.floor(tokens * 10 ** decimals));
    const amount = all || want >= raw ? raw : want;
    const slippage = Math.min(MAX_SLIPPAGE_BPS, config.slippageBps * (attempt + 1));
    const fee = config.priorityFeeLamports * 2 ** attempt;
    try {
      const sig = viaPortal
        ? await portalSwap({
            action: "sell",
            mint,
            amount: all || amount === raw ? "100%" : Number(amount) / 10 ** decimals,
            denominatedInSol: "false",
            slippage: Math.min(99, config.launchSlippagePct * (attempt + 1)),
            priorityFee: config.launchPriorityFeeSol * 2 ** attempt,
            pool: "auto", // bonding curve, or PumpSwap if it graduated while we held it
          })
        : await swap(mint, WSOL, amount, slippage, fee);
      const fill = await readFill(sig, mint);
      let sol = fill.sol;
      if (amount === raw) sol += await closeEmpty((await tokenAccounts(mint)).filter((a) => a.raw === 0n));
      return { signature: sig, tokens: -fill.tokens, sol };
    } catch (e) {
      lastErr = e;
      await log("trade", `sell ${mint} attempt ${attempt + 1}/${SELL_ATTEMPTS} failed: ${(e as Error).message}`);
    }
  }
  throw lastErr;
}
