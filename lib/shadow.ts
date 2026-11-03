/**
 * Shadow tracking: follows every signal — taken or skipped — for an hour after the decision and
 * records its peak, +15m and +60m returns. Comparing skipped vs taken by skip reason shows whether
 * each filter saves money or throws away winners.
 */
import { db } from "./db";
import { quotes } from "./market";

export async function trackSignals() {
  const rows = await db.signal.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 62 * 60_000) }, priceSol: { not: null }, ret60: null },
    select: { id: true, mint: true, priceSol: true, peakRet: true, ret15: true, createdAt: true },
  });
  if (!rows.length) return 0;
  const q = await quotes([...new Set(rows.map((r) => r.mint))]);
  for (const r of rows) {
    const price = q.get(r.mint)?.priceSol;
    if (!price || !r.priceSol) continue;
    const ageMin = (Date.now() - r.createdAt.getTime()) / 60_000;
    const ret = (price / r.priceSol - 1) * 100;
    await db.signal.update({
      where: { id: r.id },
      data: {
        peakRet: Math.max(r.peakRet ?? ret, ret),
        ...(ageMin >= 15 && r.ret15 === null ? { ret15: ret } : {}),
        ...(ageMin >= 60 ? { ret60: ret } : {}),
      },
    });
  }
  return rows.length;
}
