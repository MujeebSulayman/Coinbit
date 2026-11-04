import { CheckCircle2, Hourglass, XCircle } from "lucide-react";
import { tone } from "@/lib/fmt";
import { Money } from "../components/Money";
import { filterTest, MIN_TRADES, shadowReport, strategyPerf } from "@/lib/performance";
import AutoRefresh from "../components/AutoRefresh";
import { Badge, Empty, PageHeader, Panel, Stat, StatGrid } from "../components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Performance" };

const STRATS = [
  ["copy", "Copy trading"],
  ["migration", "Migration"],
  ["launch", "Launch sniper"],
] as const;

const pct = (v: number | null, signed = true) => (v === null ? "—" : `${signed && v > 0 ? "+" : ""}${Math.round(v) || 0}%`);

const VERDICT = {
  good: { Icon: CheckCircle2, cls: "border-up/25 bg-up/5 text-up" },
  bad: { Icon: XCircle, cls: "border-down/25 bg-down/5 text-down" },
  wait: { Icon: Hourglass, cls: "border-line bg-panel text-mute" },
} as const;

export default async function Performance() {
  const [data, ft] = await Promise.all([
    Promise.all(STRATS.map(async ([key, name]) => ({ key, name, perf: await strategyPerf(key), shadow: await shadowReport(key) }))),
    filterTest(),
  ]);

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
              <Stat label="Total PnL" value={<Money v={m.total} signed stack />} className={tone(m.total)} sub={`${m.trades} closed trades`} />
              <Stat label="Expectancy" value={<Money v={m.expectancy} signed stack />} className={tone(m.expectancy)} sub={`${pct(m.expectancyPct)} per trade`} />
              <Stat
                label="Profit factor"
                value={m.trades ? (Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞") : "—"}
                className={m.trades ? (m.profitFactor > 1.3 ? "text-up" : m.profitFactor < 1 ? "text-down" : "") : ""}
                sub="won ÷ lost · aim > 1.3"
              />
              <Stat label="Win rate" value={m.trades ? `${(m.winRate * 100).toFixed(0)}%` : "—"} />
              <Stat label="Avg win" value={m.trades ? <Money v={m.avgWin} signed stack /> : "—"} className={m.trades ? "text-up" : ""} />
              <Stat label="Avg loss" value={m.trades ? <Money v={m.avgLoss} signed stack /> : "—"} className={m.avgLoss < 0 ? "text-down" : ""} />
              <Stat
                label="Best trade share"
                value={m.bestShare === null ? "—" : `${(m.bestShare * 100).toFixed(0)}%`}
                className={m.bestShare !== null && m.bestShare >= 0.3 ? "text-warn" : ""}
                sub="of total profit · aim < 30%"
              />
              <Stat label="Max drawdown" value={<Money v={m.maxDrawdown} stack />} sub="worst peak-to-trough" />
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
                              <span className={`num min-w-24 ${tone(e.pnl)}`}><Money v={e.pnl} signed /></span>
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
            {key === "migration" && <FilterTest ft={ft} />}
          </div>
        );
      })}
    </>
  );
}

type FT = Awaited<ReturnType<typeof filterTest>>;
type Row = FT["all"];

function FilterRows({ rows, base }: { rows: Row[]; base: Row }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Group</th>
          <th>Coins</th>
          <th>Median +60m</th>
          <th>Avg +60m</th>
          <th>Hit +30%</th>
          <th>Dead at 60m</th>
          <th>We took</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td className="num text-mute">{r.n}</td>
            <td className={`num ${r.n ? tone(r.median ?? 0) : ""}`}>{r.n ? pct(r.median) : "—"}</td>
            <td className={`num ${r.n ? tone(r.avg ?? 0) : ""}`}>{r.n ? pct(r.avg) : "—"}</td>
            <td className={`num ${r.n && r.hit30 > base.hit30 ? "text-up" : ""}`}>{r.n ? pct(r.hit30 * 100, false) : "—"}</td>
            <td className={`num ${r.n && r.dead < base.dead ? "text-up" : ""}`}>{r.n ? pct(r.dead * 100, false) : "—"}</td>
            <td className="num text-mute">{r.taken}</td>
          </tr>
        ))}
        <tr className="text-faint">
          <td>All graduates</td>
          <td className="num">{base.n}</td>
          <td className="num">{base.n ? pct(base.median) : "—"}</td>
          <td className="num">{base.n ? pct(base.avg) : "—"}</td>
          <td className="num">{base.n ? pct(base.hit30 * 100, false) : "—"}</td>
          <td className="num">{base.n ? pct(base.dead * 100, false) : "—"}</td>
          <td className="num">{base.taken}</td>
        </tr>
      </tbody>
    </table>
  );
}

/** Social-link and dev-reputation filters under test: recorded on every graduate, not yet blocking trades. */
function FilterTest({ ft }: { ft: FT }) {
  return (
    <div className="space-y-2">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Filter test · social links" right={<span className="text-[12px] text-faint">X / Telegram / website</span>}>
          {ft.all.n ? <FilterRows rows={ft.socials} base={ft.all} /> : <Empty>Fills in as graduates age (60 minutes after each).</Empty>}
        </Panel>
        <Panel title="Filter test · dev reputation" right={<span className="text-[12px] text-faint">creator history</span>}>
          {ft.all.n ? <FilterRows rows={ft.dev} base={ft.all} /> : <Empty>Fills in as graduates age (60 minutes after each).</Empty>}
        </Panel>
      </div>
      <p className="px-1 text-[12px] leading-relaxed text-faint">
        Every graduate is grouped by each feature, whatever the other filters decided; green = better than all graduates. Turn a filter on in
        Settings (Entry filters · migration) only once its group has 100+ coins and a clearly better median and dead rate.
        {ft.coverageDays < 7 &&
          ` Launch history so far covers ${ft.coverageDays.toFixed(1)} days, so "quiet 7d" is a best guess until it reaches 7.`}
      </p>
    </div>
  );
}
