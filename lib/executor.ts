/**
 * Executor — paper trading by default, real Jupiter swaps in live mode.
 * Jupiter routes pump.fun coins both on the bonding curve and after migration.
 *
 * Live fills are read back from the confirmed transaction (real tokens received / SOL spent),
 * never from the quote, and sells are clamped to the wallet's actual token balance.
 */
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config";
import { log } from "./db";
import { conn, sleep, solDelta, tokenDeltas, WSOL } from "./solana";

const JUP = "https://lite-api.jup.ag/swap/v1";
const PAPER_FEE_PCT = 1; // approximates pool/curve fees so paper PnL isn't flattering
const SELL_ATTEMPTS = 3;
const MAX_SLIPPAGE_BPS = 5000;

let _kp: Keypair | null = null;
function trader(): Keypair {
  if (!_kp) {
    if (!config.traderKey) throw new Error("TRADER_PRIVATE_KEY missing (required for live mode)");
    _kp = Keypair.fromSecretKey(bs58.decode(config.traderKey));
  }
  return _kp;
}

/** empty = the wallet held none of the token, so there was nothing to sell. */
export type Fill = { signature: string | null; tokens: number; sol: number; empty?: boolean };

/** Sends a signed tx, re-broadcasting until it confirms or its blockhash expires. */
async function sendAndConfirm(raw: Uint8Array, lastValidBlockHeight: number): Promise<string> {
  if (config.jitoUrl) {
    fetch(config.jitoUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [Buffer.from(raw).toString("base64"), { encoding: "base64" }] }),
    }).catch(() => {});
  }
  const sig = await conn().sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  for (;;) {
    const { value } = await conn().getSignatureStatuses([sig]);
    const st = value[0];
    if (st?.err) throw new Error(`swap failed on-chain: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    if ((await conn().getBlockHeight("confirmed")) > lastValidBlockHeight) {
      // One last look: it may have landed right at the edge.
      const final = (await conn().getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      if (final && !final.err && final.confirmationStatus) return sig;
      throw new Error(`swap expired without confirming (${sig})`);
    }
    conn().sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    await sleep(1500);
  }
}

/** Actual token and SOL change for our wallet in a confirmed tx. */
async function readFill(sig: string, mint: string): Promise<{ tokens: number; sol: number }> {
  const owner = trader().publicKey.toBase58();
  for (let i = 0; i < 8; i++) {
    const tx = await conn()
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
  return sendAndConfirm(tx.serialize(), lastValidBlockHeight);
}

/** Raw on-chain balance of a token in our wallet (works for SPL Token and Token-2022). */
async function tokenBalance(mint: string): Promise<{ raw: bigint; decimals: number }> {
  const res = await conn().getParsedTokenAccountsByOwner(trader().publicKey, { mint: new PublicKey(mint) }, "confirmed");
  let raw = 0n;
  let decimals = 6;
  for (const a of res.value) {
    const amt = a.account.data.parsed.info.tokenAmount;
    raw += BigInt(amt.amount);
    decimals = amt.decimals;
  }
  return { raw, decimals };
}

export async function buy(mint: string, sizeSol: number, priceSol: number): Promise<Fill> {
  if (config.mode === "paper") {
    const net = sizeSol * (1 - PAPER_FEE_PCT / 100);
    return { signature: null, tokens: priceSol > 0 ? net / priceSol : 0, sol: sizeSol };
  }
  // Buys get one attempt: if the price ran away, chasing it is worse than missing it.
  const sig = await swap(WSOL, mint, BigInt(Math.floor(sizeSol * 1e9)), config.slippageBps, config.priorityFeeLamports);
  const fill = await readFill(sig, mint);
  if (fill.tokens <= 0) throw new Error(`buy ${sig} confirmed but received no tokens`);
  // SOL spent includes network fees and token-account rent: the true cost of the position.
  return { signature: sig, tokens: fill.tokens, sol: -fill.sol };
}

/** Sells `tokens` (or everything held when `all`), retrying with wider slippage and higher fees. */
export async function sell(mint: string, tokens: number, priceSol: number, all = false): Promise<Fill> {
  if (config.mode === "paper") {
    return { signature: null, tokens, sol: tokens * priceSol * (1 - PAPER_FEE_PCT / 100) };
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < SELL_ATTEMPTS; attempt++) {
    const bal = await tokenBalance(mint);
    if (bal.raw === 0n) return { signature: null, tokens: 0, sol: 0, empty: true };
    const want = BigInt(Math.floor(tokens * 10 ** bal.decimals));
    const amount = all || want >= bal.raw ? bal.raw : want;
    const slippage = Math.min(MAX_SLIPPAGE_BPS, config.slippageBps * (attempt + 1));
    const fee = config.priorityFeeLamports * 2 ** attempt;
    try {
      const sig = await swap(mint, WSOL, amount, slippage, fee);
      const fill = await readFill(sig, mint);
      return { signature: sig, tokens: -fill.tokens, sol: fill.sol };
    } catch (e) {
      lastErr = e;
      await log("trade", `sell ${mint} attempt ${attempt + 1}/${SELL_ATTEMPTS} failed: ${(e as Error).message}`);
    }
  }
  throw lastErr;
}
