/**
 * Dev reputation. In a study of 693k pump.fun launches, coins whose creator had graduated a coin
 * before AND launched nothing else in the previous 7 days graduated at 12% vs a 1.7% baseline;
 * serial launchers (a new coin every few hours) are the opposite. We record both facts on every
 * migration signal so the Performance page can show whether they predict returns after graduation.
 *
 * Data is our own, so it starts from when recording began:
 *  - launches: every pump.fun create from the PumpPortal feed → Launch table (kept 10 days)
 *  - graduations: every migrate event → Token table, with the creator read from the bonding curve
 */
import { db } from "./db";
import { startPortal, type PortalTrade } from "./pumpportal";
import { getBondingCurves } from "./solana";

const WEEK_MS = 7 * 864e5;
/** More graduates than this in our (short) history = a graduation factory, not a proven dev. */
export const FACTORY_GRADS = 5;
let buffer: { mint: string; creator: string; at: Date }[] = [];

function onCreate(m: PortalTrade) {
  if (!m.traderPublicKey) return;
  buffer.push({ mint: m.mint, creator: m.traderPublicKey, at: new Date() });
}

async function flush() {
  if (!buffer.length) return;
  const rows = buffer;
  buffer = [];
  await db.launch.createMany({ data: rows, skipDuplicates: true }).catch((e) => {
    console.error("[devrep] launch flush failed", (e as Error).message);
    if (buffer.length < 5000) buffer.unshift(...rows); // retry next time (bounded)
  });
}

/** Records every pump.fun launch (batched into one insert every 15s, ~0.35 launches/sec). */
export function startLaunchRecorder() {
  startPortal({ onCreate });
  setInterval(() => flush().catch(() => {}), 15_000);
}

/** Fills in the creator of recorded graduates that don't have one (read from their bonding curves). */
export async function backfillCreators(limit = 2000) {
  const rows = await db.token.findMany({ where: { creator: null }, select: { mint: true }, take: limit });
  if (!rows.length) return 0;
  const curves = await getBondingCurves(rows.map((r) => r.mint));
  const found = [...curves].filter(([, c]) => c.creator);
  if (!found.length) return 0;
  const mints = found.map(([m]) => m);
  const creators = found.map(([, c]) => c.creator as string);
  return db.$executeRaw`UPDATE "Token" t SET creator = v.creator
    FROM unnest(${mints}::text[], ${creators}::text[]) AS v(mint, creator) WHERE t.mint = v.mint`;
}

export type DevRep = {
  creator: string;
  grads: number; // other coins by this creator that graduated
  recent: number; // other coins launched in the last 7 days
  proven: boolean; // graduated before (but not a factory) and quiet for 7 days
  coverageDays: number; // how far back our launch history goes (the 7-day count is a lower bound below 7)
};

export async function devReputation(mint: string, creator: string | null | undefined): Promise<DevRep | null> {
  if (!creator) return null;
  const since = new Date(Date.now() - WEEK_MS);
  const [grads, recent, oldest] = await Promise.all([
    db.token.count({ where: { creator, mint: { not: mint } } }),
    db.launch.count({ where: { creator, mint: { not: mint }, at: { gte: since } } }),
    db.launch.findFirst({ orderBy: { at: "asc" }, select: { at: true } }),
  ]);
  const coverageDays = oldest ? (Date.now() - oldest.at.getTime()) / 864e5 : 0;
  return { creator, grads, recent, proven: grads > 0 && grads < FACTORY_GRADS && recent === 0, coverageDays };
}

export const devRepText = (d: DevRep) =>
  `dev: ${d.grads} prior graduate${d.grads === 1 ? "" : "s"}, ${d.recent} other launch${d.recent === 1 ? "" : "es"} in 7d`;
