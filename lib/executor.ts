/**
 * Executor — paper trading by default, real Jupiter swaps in live mode.
 * Jupiter routes pump.fun coins both on the bonding curve and after migration.
 */
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "./config";
import { conn, PUMP_DECIMALS, WSOL } from "./solana";

const JUP = "https://lite-api.jup.ag/swap/v1";

let _kp: Keypair | null = null;
function trader(): Keypair {
  if (!_kp) {
    if (!config.traderKey) throw new Error("TRADER_PRIVATE_KEY missing (required for live mode)");
    _kp = Keypair.fromSecretKey(bs58.decode(config.traderKey));
  }
  return _kp;
}

export type Fill = { signature: string | null; tokens: number; sol: number };

async function swap(inputMint: string, outputMint: string, amountRaw: bigint): Promise<{ sig: string; outRaw: bigint }> {
  const user = trader().publicKey.toBase58();
  const qRes = await fetch(
    `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${config.slippageBps}`,
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
      prioritizationFeeLamports: config.priorityFeeLamports,
    }),
  });
  if (!sRes.ok) throw new Error(`jupiter swap ${sRes.status}: ${await sRes.text()}`);
  const { swapTransaction } = (await sRes.json()) as { swapTransaction: string };

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([trader()]);
  const raw = tx.serialize();

  if (config.jitoUrl) {
    // Fire-and-forget to Jito for faster inclusion; RPC send below is the fallback path.
    fetch(config.jitoUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [Buffer.from(raw).toString("base64"), { encoding: "base64" }] }),
    }).catch(() => {});
  }
  const sig = await conn().sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  const bh = await conn().getLatestBlockhash();
  const res = await conn().confirmTransaction({ signature: sig, ...bh }, "confirmed");
  if (res.value.err) throw new Error(`swap failed on-chain: ${JSON.stringify(res.value.err)}`);
  return { sig, outRaw: BigInt(quote.outAmount) };
}

export async function buy(mint: string, sizeSol: number, priceSol: number): Promise<Fill> {
  if (config.mode === "paper") {
    return { signature: null, tokens: priceSol > 0 ? sizeSol / priceSol : 0, sol: sizeSol };
  }
  const { sig, outRaw } = await swap(WSOL, mint, BigInt(Math.floor(sizeSol * 1e9)));
  return { signature: sig, tokens: Number(outRaw) / 10 ** PUMP_DECIMALS, sol: sizeSol };
}

export async function sell(mint: string, tokens: number, priceSol: number): Promise<Fill> {
  if (config.mode === "paper") {
    return { signature: null, tokens, sol: tokens * priceSol };
  }
  const { sig, outRaw } = await swap(mint, WSOL, BigInt(Math.floor(tokens * 10 ** PUMP_DECIMALS)));
  return { signature: sig, tokens, sol: Number(outRaw) / 1e9 };
}
