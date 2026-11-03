import "dotenv/config";
import { Keypair } from "@solana/web3.js";
import { stream } from "./lib/stream";
(async () => {
  // A brand-new, empty account: it never changes, so the socket stays completely quiet.
  stream().subscribe("accountSubscribe", [Keypair.generate().publicKey.toBase58(), { encoding: "jsonParsed", commitment: "confirmed" }], () => {});
  await new Promise((r) => setTimeout(r, 140_000));
  console.log("after 140s of silence → healthy:", stream().healthy, "reconnects:", stream().reconnects);
  process.exit(0);
})();
