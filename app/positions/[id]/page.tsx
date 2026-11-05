import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { ago, tone, usd } from "@/lib/fmt";
import { Money } from "../../components/Money";
import { clock } from "@/lib/time";
import { stopLevel } from "@/lib/exits";
import { effectiveSettings } from "@/lib/settings";
import AutoRefresh from "../../components/AutoRefresh";
import CopyButton from "../../components/CopyButton";
import MarketChart from "../../components/MarketChart";
import PriceChart, { type FillPt, type RefLine } from "../../components/PriceChart";
import { Addr, Badge, Panel, Stat, StatGrid } from "../../components/ui";
import { CloseButton, StrategyTag } from "../table";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const p = Number.isInteger(id) ? await db.position.findUnique({ where: { id }, select: { symbol: true, mint: true } }) : null;
  return { title: p ? `${p.symbol ?? p.mint.slice(0, 8)} · Trade #${id}` : "Trade not found" };
}

type Ladder = { gainPct: number; sellPct: number }[];
const pct = (v: number | null | undefined, signed = true) =>
  v == null ? "—" : `${signed && v > 0 ? "+" : ""}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%`;
const duration = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="btn btn-sm">
      {children}
      <ExternalLink size={12} />
    </a>
  );
}

export default async function TradePage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const p = await db.position.findUnique({ where: { id } });
  if (!p) notFound();

  const [fills, points, signal, eff, wallets] = await Promise.all([
    db.fill.findMany({ where: { positionId: id }, orderBy: { ts: "asc" } }),
    db.pricePoint.findMany({ where: { positionId: id }, orderBy: { ts: "asc" }, select: { ts: true, priceSol: true } }),
    db.signal.findFirst({ where: { positionId: id } }),
    effectiveSettings(),
    db.wallet.findMany({
      where: { address: { in: p.triggerWallets } },
      select: { address: true, status: true, kind: true, histWinRate: true, histPnlSol: true, histTokens: true, copyPnlSol: true },
    }),
  ]);

  // The worker's settings (what's actually in force), not this server's environment.
  const v = eff.values as Record<string, unknown>;
  const migration = p.strategy === "migration";
  const launch = p.strategy === "launch";
  const prefix = migration ? "migration" : launch ? "launch" : "";
  const key = (k: string) => (prefix ? prefix + k[0].toUpperCase() + k.slice(1) : k);
  const ladder = (launch ? [] : v[key("tpLevels")]) as Ladder;
  const sellLadder = (launch ? v.launchSellLadder : []) as Ladder; // gainPct = blocks after the buy
  const stopLossPct = Number(v[key("stopLossPct")]);
  const maxHoldMin = Number(v[key("maxHoldMin")]);
  const stop = stopLevel(launch ? { ...p, tpHit: 0 } : p, stopLossPct, {
    breakevenAfterTp: !!v.breakevenAfterTp,
    breakevenBufferPct: Number(v.breakevenBufferPct),
    trailAfterTpPct: Number(v.trailAfterTpPct),
    profitLockArmPct: Number(v.profitLockArmPct ?? 0),
    profitLockKeepPct: Number(v.profitLockKeepPct ?? 55),
  });

  const open = p.status === "OPEN";
  const value = p.remainingTokens * p.currentPriceSol;
  const pnl = p.realizedSol + value - p.sizeSol;
  const move = (p.currentPriceSol / p.entryPriceSol - 1) * 100;
  const peak = (p.peakPriceSol / p.entryPriceSol - 1) * 100;
  const held = (p.closedAt ?? new Date()).getTime() - p.openedAt.getTime();
  const nextTp = ladder?.[p.tpHit];
  const nextLeg = sellLadder[p.tpHit];
  const closesAt = new Date(p.openedAt.getTime() + maxHoldMin * 60_000);

  const refs: RefLine[] = [{ pct: 0, label: "entry", kind: "entry" }];
  if (open) refs.push({ pct: stop.stopPct, label: `${stop.stopKind === "stop-loss" ? "stop" : stop.stopKind === "break-even" ? "b/e" : "trail"} ${pct(stop.stopPct)}`, kind: "stop" });
  ladder?.forEach((l, i) => refs.push({ pct: l.gainPct, label: `TP${i + 1} +${l.gainPct}%`, kind: i < p.tpHit ? "tp-hit" : "tp" }));

  const chartPoints = points.map((x) => ({ t: x.ts.getTime(), p: x.priceSol }));
  if (open && chartPoints.length) chartPoints.push({ t: Date.now(), p: p.currentPriceSol });
  const chartFills: FillPt[] = fills
    .filter((f) => f.priceSol > 0)
    .map((f) => ({ t: f.ts.getTime(), p: f.priceSol, side: f.side as "BUY" | "SELL", sol: f.sol, reason: f.reason }));

  const checks: [string, string][] = signal
    ? [
        ["Market cap", usd(signal.mcapUsd)],
        ["Age at entry", signal.ageMin != null ? `${Math.round(signal.ageMin)}m` : "—"],
        ["Top 10 holders", pct(signal.top10Pct, false)],
        ["Dev holding", pct(signal.devHoldPct, false)],
        ["Launch snipers", pct(signal.snipePct, false)],
        ["Curve progress", pct(signal.curvePct, false)],
        ["Price impact", pct(signal.impactPct, false)],
        ["Wallets agreeing", String(signal.confluence)],
      ]
    : [];

  return (
    <>
      {open && <AutoRefresh ms={launch ? 1500 : 3000} />}
      <div className="space-y-3">
        <Link href="/positions" className="inline-flex items-center gap-1.5 text-[12.5px] text-faint hover:text-ink">
          <ArrowLeft size={14} /> Positions
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[22px] font-semibold tracking-tight">{p.symbol ?? p.mint.slice(0, 8)}</h1>
              {open ? (
                <Badge kind="up" dot>
                  Open · live
                </Badge>
              ) : (
                <Badge>Closed · {p.exitReason}</Badge>
              )}
              <StrategyTag p={p} />
            </div>
            <div className="flex items-center gap-1">
              <span className="mono break-all text-[11.5px] text-faint">{p.mint}</span>
              <CopyButton text={p.mint} label="Copy mint address" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ExtLink href={`https://pump.fun/coin/${p.mint}`}>pump.fun</ExtLink>
            <ExtLink href={`https://dexscreener.com/solana/${p.mint}`}>DexScreener</ExtLink>
            <ExtLink href={`https://gmgn.ai/sol/token/${p.mint}`}>GMGN</ExtLink>
            <ExtLink href={`https://solscan.io/token/${p.mint}`}>Solscan</ExtLink>
            {open && <CloseButton p={p} />}
          </div>
        </div>
      </div>

      <StatGrid cols="grid-cols-2 md:grid-cols-4 lg:grid-cols-8">
        <Stat label="PnL" value={<Money v={pnl} signed stack />} className={tone(pnl)} sub={pct(p.sizeSol ? (pnl / p.sizeSol) * 100 : 0)} />
        <Stat label={open ? "Price now" : "Last price"} value={pct(move)} className={tone(move)} sub="vs entry" />
        <Stat label="Peak" value={pct(peak)} className={tone(peak)} sub="best price seen" />
        <Stat label="Size" value={<Money v={p.sizeSol} stack />} sub={p.mode === "LIVE" ? "real SOL" : "paper"} />
        <Stat label="Realized" value={<Money v={p.realizedSol} stack />} sub={`${fills.filter((f) => f.side === "SELL").length} sells`} />
        <Stat label="Still held" value={open ? <Money v={value} stack /> : "—"} sub={open ? `${((p.remainingTokens / p.tokenAmount) * 100).toFixed(0)}% of bag` : "sold"} />
        {launch ? (
          <Stat label="Sell ladder" value={`${p.tpHit} / ${sellLadder.length}`} sub={nextLeg ? `next at block +${nextLeg.gainPct}` : "done"} />
        ) : (
          <Stat label="Take-profits" value={`${p.tpHit} / ${ladder?.length ?? 0}`} sub={nextTp ? `next +${nextTp.gainPct}%` : "all hit"} />
        )}
        <Stat label={open ? "Held for" : "Held"} value={duration(held)} sub={open ? `time exit ${ago(closesAt).replace(" ago", "")}` : `closed ${ago(p.closedAt)}`} />
      </StatGrid>

      <Panel
        title="Price since entry"
        right={
          open ? (
            <span className="flex items-center gap-1.5 text-[12px] text-faint">
              <span className="live-dot size-1.5 rounded-full bg-up" /> updates every few seconds
            </span>
          ) : undefined
        }
      >
        <div className="px-3 pb-2 pt-3">
          <PriceChart entry={p.entryPriceSol} points={chartPoints} fills={chartFills} refs={refs} />
        </div>
      </Panel>

      <Panel
        title="Market chart"
        right={
          <a href={`https://pump.fun/coin/${p.mint}`} target="_blank" rel="noreferrer" className="text-[12px] text-faint hover:text-ink">
            Open on pump.fun ↗
          </a>
        }
      >
        <MarketChart
          mint={p.mint}
          from={p.openedAt.getTime()}
          to={p.closedAt?.getTime() ?? null}
          live={open}
          entry={p.entryPriceSol}
          fills={chartFills}
        />
      </Panel>

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="min-w-0 space-y-5 lg:col-span-3">
          <Panel title="Fills" count={fills.length}>
            {fills.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Side</th>
                    <th className="r">SOL</th>
                    <th className="r">Price vs entry</th>
                    <th>Reason</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {fills.map((f) => {
                    const at = f.priceSol > 0 ? (f.priceSol / p.entryPriceSol - 1) * 100 : null;
                    return (
                      <tr key={f.id}>
                        <td className="num text-faint">{clock(f.ts)}</td>
                        <td>{f.side === "BUY" ? <Badge>Buy</Badge> : <Badge kind={at !== null && at < 0 ? "down" : "up"}>Sell</Badge>}</td>
                        <td className="num r"><Money v={f.side === "BUY" ? -f.sol : f.sol} signed /></td>
                        <td className={`num r ${at === null ? "text-faint" : tone(at)}`}>{at === null ? "—" : pct(at)}</td>
                        <td className="text-mute">{f.reason}</td>
                        <td>
                          {f.signature ? (
                            <a className="mono text-link hover:underline" href={`https://solscan.io/tx/${f.signature}`} target="_blank" rel="noreferrer">
                              {f.signature.slice(0, 6)}…
                            </a>
                          ) : (
                            <span className="text-faint">{p.mode === "PAPER" ? "paper" : "—"}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="px-4 py-8 text-center text-[13px] text-faint">No fills recorded.</div>
            )}
          </Panel>

          {signal && (
            <Panel title="Why the bot bought">
              <div className="space-y-3 px-4 py-3">
                <p className="text-[13px] text-mute">{signal.reason}</p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-4">
                  {checks.map(([k, val]) => (
                    <div key={k}>
                      <div className="text-[11px] uppercase tracking-wider text-faint">{k}</div>
                      <div className="num text-[13px]">{val}</div>
                    </div>
                  ))}
                </div>
                <div className="text-[12px] text-faint">Signal {ago(signal.createdAt)}</div>
              </div>
            </Panel>
          )}
        </div>

        <div className="min-w-0 space-y-5 lg:col-span-2">
          <Panel title="Exit plan">
            <div className="divide-y divide-line text-[13px]">
              {open && (
                <div className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-mute">Sells the rest at</span>
                  <span className={`num font-medium ${tone(stop.stopPct)}`}>
                    {pct(stop.stopPct)} <span className="font-normal text-faint">({stop.stopKind})</span>
                  </span>
                </div>
              )}
              {sellLadder.map((l, i) => (
                <div key={`leg${i}`} className="flex items-center justify-between px-4 py-2.5">
                  <span className={i < p.tpHit ? "text-faint line-through" : "text-mute"}>
                    Sell {l.sellPct}% at block +{l.gainPct}
                  </span>
                  <span className="num text-faint">≈{(l.gainPct * 0.4).toFixed(1)}s{i < p.tpHit ? " ✓" : ""}</span>
                </div>
              ))}
              {launch && v.launchExitOnDevSell ? (
                <div className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-mute">Creator sells</span>
                  <span>sell everything</span>
                </div>
              ) : null}
              {ladder?.map((l, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2.5">
                  <span className={i < p.tpHit ? "text-faint line-through" : "text-mute"}>
                    Take-profit {i + 1}: sell {l.sellPct}%
                  </span>
                  <span className={`num ${i < p.tpHit ? "text-faint" : "text-up"}`}>+{l.gainPct}%{i < p.tpHit ? " ✓" : ""}</span>
                </div>
              ))}
              <div className="flex items-center justify-between px-4 py-2.5">
                <span className="text-mute">Time limit</span>
                <span className="num">{maxHoldMin}m</span>
              </div>
              {!migration && (
                <div className="flex items-center justify-between px-4 py-2.5">
                  <span className="text-mute">Mirror exits</span>
                  <span>{v.mirrorExits ? "on" : "off"}</span>
                </div>
              )}
            </div>
          </Panel>

          <Panel title="Triggered by" count={p.triggerWallets.length}>
            {p.triggerWallets.length ? (
              <div className="divide-y divide-line">
                {p.triggerWallets.map((a) => {
                  const w = wallets.find((x) => x.address === a);
                  return (
                    <div key={a} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[12.5px]">
                      <span className="flex items-center gap-0.5">
                        <Addr a={a} href={`https://gmgn.ai/sol/address/${a}`} />
                        <CopyButton text={a} label="Copy wallet address" />
                      </span>
                      <span className="num text-faint">
                        {w?.histTokens != null ? <>{((w.histWinRate ?? 0) * 100).toFixed(0)}% win · <Money v={w.histPnlSol ?? 0} signed /></> : w?.kind === "LAUNCHER" ? "launcher" : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="px-4 py-6 text-center text-[13px] text-faint">
                {migration ? "Migration trade: triggered by the graduation, not by wallets." : launch ? "Launch snipe: triggered by the coin's creation." : "—"}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
