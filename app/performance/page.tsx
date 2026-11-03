import { sol, tone } from "@/lib/fmt";
import { MIN_TRADES, shadowReport, strategyPerf } from "@/lib/performance";
import AutoRefresh from "../components/AutoRefresh";
import { Badge, Empty, PageHeader, Panel, Stat } from "../components/ui";

export const dynamic = "force-dynamic";

const STRATS = [
  ["copy", "Copy trading"],
  ["migration", "Migration"],
] as const;

const pct = (v: number | null, signed = true) => (v === null ? "—" : `${signed && v > 0 ? "+" : ""}${v.toFixed(0)}%`);

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
        return (
          <div key={key} className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-[17px] font-semibold">{name}</h2>
              <Badge kind={perf.verdict.kind === "good" ? "up" : perf.verdict.kind === "bad" ? "down" : "mute"}>{perf.verdict.text}</Badge>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
              <Stat label="Closed trades" value={m.trades} sub={`goal ${MIN_TRADES}+`} />
              <Stat label="Total PnL" value={sol(m.total, true)} className={tone(m.total)} />
              <Stat label="Expectancy" value={sol(m.expectancy, true)} className={tone(m.expectancy)} sub={`${pct(m.expectancyPct)} per trade`} />
              <Stat
                label="Profit factor"
                value={m.trades ? (Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞") : "—"}
                sub="won ÷ lost · aim > 1.3"
              />
              <Stat label="Win rate" value={m.trades ? `${(m.winRate * 100).toFixed(0)}%` : "—"} />
              <Stat label="Avg win / loss" value={m.trades ? `${sol(m.avgWin)} / ${sol(Math.abs(m.avgLoss))}` : "—"} />
              <Stat label="Best trade share" value={m.bestShare === null ? "—" : `${(m.bestShare * 100).toFixed(0)}%`} sub="of total profit · aim < 30%" />
              <Stat label="Max drawdown" value={sol(m.maxDrawdown)} sub="worst peak-to-trough" />
            </div>

            <div className="grid gap-6 lg:grid-cols-5">
              <div className="min-w-0 lg:col-span-2">
                <Panel title="PnL by exit reason">
                  {perf.byExit.length ? (
                    <table>
                      <thead>
                        <tr>
                          <th>Exit</th>
                          <th className="r">Trades</th>
                          <th className="r">PnL</th>
                        </tr>
                      </thead>
                      <tbody>
                        {perf.byExit.map(([k, e]) => (
                          <tr key={k}>
                            <td>{k}</td>
                            <td className="num r">{e.n}</td>
                            <td className={`num r ${tone(e.pnl)}`}>{sol(e.pnl, true)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <Empty>No closed trades yet.</Empty>
                  )}
                </Panel>
              </div>
              <div className="min-w-0 lg:col-span-3">
                <Panel title="What happened after each decision (shadow tracking)">
                  {shadow.length ? (
                    <table>
                      <thead>
                        <tr>
                          <th>Decision</th>
                          <th className="r">Signals</th>
                          <th className="r">Avg +15m</th>
                          <th className="r">Avg +60m</th>
                          <th className="r">Hit +50%</th>
                          <th className="r">Dead at 60m</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shadow.map((g) => (
                          <tr key={g.decision + g.reason}>
                            <td className="whitespace-normal">
                              {g.decision === "TAKEN" ? <Badge kind="up">Taken</Badge> : <span className="text-mute">Skipped: {g.reason}</span>}
                            </td>
                            <td className="num r">{g.n}</td>
                            <td className={`num r ${tone(g.avg15 ?? 0)}`}>{pct(g.avg15)}</td>
                            <td className={`num r ${tone(g.avg60 ?? 0)}`}>{pct(g.avg60)}</td>
                            <td className="num r">{pct(g.hit50 * 100, false)}</td>
                            <td className="num r">{pct(g.dead * 100, false)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <Empty>Fills in as signals age (15 and 60 minutes after each decision).</Empty>
                  )}
                </Panel>
                <p className="mt-2 text-[12.5px] text-faint">
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
