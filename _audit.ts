import "dotenv/config";
import { writeFileSync } from "node:fs";
import { PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { db } from "./lib/db";
import { bondingCurvePda, conn, getParsedTxs, WSOL } from "./lib/solana";
// Read-only audit: every recorded fill vs real on-chain plain-SOL trades on the same coin within ±30s.
const WIN = 30, MIN_SOL = 0.05, MAX_PAGES = 20;
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
(async () => {
  const ps = await db.position.findMany({ orderBy: { id: "asc" } });
  const rows: any[] = [];
  for (const p of ps) {
    const fills = await db.fill.findMany({ where: { positionId: p.id }, orderBy: { ts: "asc" } });
    if (!fills.length) continue;
    // Where the coin traded at that time: the curve, or the PumpSwap pool for migration trades.
    const venue = p.strategy === "migration" && p.pool ? new PublicKey(p.pool) : bondingCurvePda(p.mint);
    const lo = fills[0].ts.getTime() / 1000 - WIN, hi = fills[fills.length - 1].ts.getTime() / 1000 + WIN;
    const sigs: ConfirmedSignatureInfo[] = [];
    let before: string | undefined, reached = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await conn().getSignaturesForAddress(venue, { before, limit: 1000 }).catch(() => []);
      if (!batch.length) { reached = true; break; }
      sigs.push(...batch.filter((s) => !s.err && s.blockTime && s.blockTime >= lo && s.blockTime <= hi));
      before = batch[batch.length - 1].signature;
      if ((batch[batch.length - 1].blockTime ?? 0) < lo) { reached = true; break; }
    }
    for (const f of fills) {
      const t = f.ts.getTime() / 1000;
      const cand = sigs.filter((s) => Math.abs(s.blockTime! - t) <= WIN).sort((a, b) => Math.abs(a.blockTime! - t) - Math.abs(b.blockTime! - t)).slice(0, 15);
      const txs = await getParsedTxs(cand.map((s) => s.signature), 4);
      const prices: number[] = [];
      for (const tx of txs) {
        if (!tx?.meta) continue;
        const payer = tx.transaction.message.accountKeys[0].pubkey.toBase58();
        const d = new Map<string, number>();
        for (const b of tx.meta.postTokenBalances ?? []) if (b.owner === payer) d.set(b.mint, (d.get(b.mint) ?? 0) + Number(b.uiTokenAmount.uiAmount ?? 0));
        for (const b of tx.meta.preTokenBalances ?? []) if (b.owner === payer) d.set(b.mint, (d.get(b.mint) ?? 0) - Number(b.uiTokenAmount.uiAmount ?? 0));
        const coin = d.get(p.mint) ?? 0;
        const sol = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9 + (d.get(WSOL) ?? 0); // SOL + wrapped SOL
        const other = [...d].some(([m, x]) => m !== p.mint && m !== WSOL && Math.abs(x) > 1e-9);
        if (!coin || other || Math.abs(sol) < MIN_SOL || Math.sign(sol) === Math.sign(coin)) continue;
        prices.push(Math.abs(sol / coin));
      }
      const real = prices.length ? median(prices) : null;
      rows.push({ id: p.id, strategy: p.strategy, symbol: p.symbol, mint: p.mint, side: f.side, reason: f.reason, botPrice: f.priceSol, real, n: prices.length, ratio: real ? f.priceSol / real : null, coverage: reached || sigs.length > 0 });
    }
    process.stdout.write(".");
  }
  writeFileSync("/private/tmp/claude-501/-Users-user-Documents-Coinbit/1c936b4a-3260-4cc7-9d52-4e8cfbced68d/scratchpad/audit.json", JSON.stringify(rows));
  console.log(`\nfills audited: ${rows.length}`);
  await db.$disconnect();
})();
