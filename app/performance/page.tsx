import { CheckCircle2, Hourglass, XCircle } from "lucide-react";
import { sol, tone } from "@/lib/fmt";
import { MIN_TRADES, shadowReport, strategyPerf } from "@/lib/performance";
import AutoRefresh from "../components/AutoRefresh";
import { Badge, Empty, PageHeader, Panel, Stat, StatGrid } from "../components/ui";

export const dynamic = "force-dynamic";

const STRATS = [
  ["copy", "Copy trading"],
  ["migration", "Migration"],
] as const;

const pct = (v: number | null, signed = true) => (v === null ? "—" : `${signed && v > 0 ? "+" : ""}${Math.round(v) || 0}%`);

const VERDICT = {
  good: { Icon: CheckCircle2, cls: "border-up/25 bg-up/5 text-up" },
  bad: { Icon: XCircle, cls: "border-down/25 bg-down/5 text-down" },
  wait: { Icon: Hourglass, cls: "border-line bg-panel text-mute" },
} as const;

export default async function Performance() {
  const data = await Promise.all(
    STRATS.map(async ([key, name]) => ({ key, name, perf: await strategyPerf(key), shadow: await shadowReport(key) })),
  );

  return (
    <>
      <AutoRefresh ms={30_000} />
      <PageHeader
        title="Performance"
        description={`Whether each strategy makes money over many trades. Judge only after ${MIN_TRADES}+ closed trades; paper results are a best case.`}
      />

      {data.map(({ key, name, perf, shadow }) => {
        const m = perf.metrics;
        const v = VERDICT[perf.verdict.kind];
        const progress = Math.min(1, m.trades / MIN_TRADES);
        const maxExit = Math.max(1e-9, ...perf.byExit.map(([, e]) => Math.abs(e.pnl)));
        return (
          <div key={key} className="space-y-4 border-t border-line pt-6 first-of-type:border-t-0 first-of-type:pt-0">
            <h2 className="text-[16px] font-semibold tracking-tight">{name}</h2>

            <div className={`flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border px-4 py-3 ${v.cls}`}>
              <div className="flex items-center gap-2.5 text-[13px] font-medium">
                <v.Icon size={16} />
                {perf.verdict.text}
              </div>
              <div className="ml-auto flex items-center gap-3 text-[12px] text-faint">
                <span className="num">
                  {m.trades}/{MIN_TRADES} trades
                </span>
                <span className="h-1.5 w-32 overflow-hidden rounded-full bg-line-strong">
                  <span className="block h-full rounded-full bg-current" style={{ width: `${progress * 100}%` }} />
                </span>
              </div>
            </div>

            <StatGrid cols="grid-cols-2 md:grid-cols-4">
              <Stat label="Total PnL" value={sol(m.total, true)} className={tone(m.total)} sub={`${m.trades} closed trades`} />
              <Stat label="Expectancy" value={sol(m.expectancy, true)} className={tone(m.expectancy)} sub={`${pct(m.expectancyPct)} per trade`} />
              <Stat
                label="Profit factor"
                value={m.trades ? (Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞") : "—"}
                className={m.trades ? (m.profitFactor > 1.3 ? "text-up" : m.profitFactor < 1 ? "text-down" : "") : ""}
                sub="won ÷ lost · aim > 1.3"
              />
              <Stat label="Win rate" value={m.trades ? `${(m.winRate * 100).toFixed(0)}%` : "—"} />
              <Stat label="Avg win" value={m.trades ? sol(m.avgWin, true) : "—"} className={m.trades ? "text-up" : ""} />
              <Stat label="Avg loss" value={m.trades ? sol(m.avgLoss, true) : "—"} className={m.avgLoss < 0 ? "text-down" : ""} />
              <Stat
                label="Best trade share"
                value={m.bestShare === null ? "—" : `${(m.bestShare * 100).toFixed(0)}%`}
                className={m.bestShare !== null && m.bestShare >= 0.3 ? "text-warn" : ""}
                sub="of total profit · aim < 30%"
              />
              <Stat label="Max drawdown" value={sol(m.maxDrawdown)} sub="worst peak-to-trough" />
            </StatGrid>

            <div className="grid gap-4 lg:grid-cols-5">
              <Panel className="lg:col-span-2" title="PnL by exit reason">
                {perf.byExit.length ? (
                  <table>
                    <thead>
                      <tr>
                        <th>Exit</th>
                        <th>Trades</th>
                        <th>PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {perf.byExit.map(([k, e]) => (
                        <tr key={k}>
                          <td>{k}</td>
                          <td className="num text-mute">{e.n}</td>
                          <td>
                            <span className="inline-flex items-center gap-2">
                              <span className={`num w-24 ${tone(e.pnl)}`}>{sol(e.pnl, true)}</span>
                              <span className="h-1 w-14 overflow-hidden rounded-full bg-line-strong">
                                <span
                                  className={`block h-full rounded-full ${e.pnl >= 0 ? "bg-up" : "bg-down"}`}
                                  style={{ width: `${(Math.abs(e.pnl) / maxExit) * 100}%` }}
                                />
                              </span>
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Empty>No closed trades yet.</Empty>
                )}
              </Panel>
              <div className="min-w-0 space-y-2 lg:col-span-3">
                <Panel title="What happened after each decision" right={<span className="text-[12px] text-faint">shadow tracking</span>}>
                  {shadow.length ? (
                    <table>
                      <thead>
                        <tr>
                          <th>Decision</th>
                          <th>Signals</th>
                          <th>Avg +15m</th>
                          <th>Avg +60m</th>
                          <th>Hit +50%</th>
                          <th>Dead at 60m</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shadow.map((g) => (
                          <tr key={g.decision + g.reason}>
                            <td className="max-w-72 truncate" title={g.reason}>
                              {g.decision === "TAKEN" ? (
                                <Badge kind="up" dot>
                                  Taken
                                </Badge>
                              ) : (
                                <span className="text-mute">Skipped · {g.reason}</span>
                              )}
                            </td>
                            <td className="num text-mute">{g.n}</td>
                            <td className={`num ${tone(g.avg15 ?? 0)}`}>{pct(g.avg15)}</td>
                            <td className={`num ${tone(g.avg60 ?? 0)}`}>{pct(g.avg60)}</td>
                            <td className="num">{pct(g.hit50 * 100, false)}</td>
                            <td className="num">{pct(g.dead * 100, false)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <Empty>Fills in as signals age (15 and 60 minutes after each decision).</Empty>
                  )}
                </Panel>
                <p className="px-1 text-[12px] leading-relaxed text-faint">
                  A skip reason whose coins often hit +50% and rarely die is filtering out winners: loosen it. One whose coins mostly die is
                  doing its job. Prices here are market prices, before fees and slippage.
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}
