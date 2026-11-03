import "dotenv/config";
import { bondingCurvePda, conn, getParsedTxs, oldestSignatures } from "./lib/solana";
(async () => {
  const curve = bondingCurvePda("HsprHxBRgiVaQdRf3TnKNuZZtaX9JUSPgMFdAkk6pump");
  let sigs;
  try { const r = await oldestSignatures(curve); sigs = r.sigs; console.log("sigs OK", sigs.length, r.reachedStart); }
  catch (e) { console.log("SIGS FAIL", (e as Error).message.slice(0, 300)); return; }
  const ok = sigs.filter((s) => !s.err).slice(0, 180).map((s) => s.signature);
  for (let i = 0; i < ok.length; i += 25) {
    try { await getParsedTxs(ok.slice(i, i + 25)); }
    catch (e) {
      console.log("PARSE FAIL chunk", i, (e as Error).message.slice(0, 200));
      for (const s of ok.slice(i, i + 25)) {
        try { await conn().getParsedTransaction(s, { maxSupportedTransactionVersion: 1 }); }
        catch (e2) {
          const raw = await (await fetch(process.env.SOLANA_RPC_URL!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [s, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }] }) })).json();
          const r = raw.result;
          console.log("bad sig", s, "version", r?.version, "msg keys", Object.keys(r?.transaction?.message ?? {}));
          console.log(JSON.stringify(r?.transaction?.message?.instructions?.slice(0, 2))?.slice(0, 600));
          console.log("inner sample", JSON.stringify(r?.meta?.innerInstructions?.[0])?.slice(0, 400));
          return;
        }
      }
    }
  }
  console.log("all chunks OK");
})();
