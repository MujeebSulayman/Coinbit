import { db } from "@/lib/db";
import { ago, sol, tone, usd } from "@/lib/fmt";
import { getStats } from "@/lib/stats";
import AutoRefresh from "./components/AutoRefresh";
import { Button } from "./components/Controls";
import { Badge, Coin, Empty, PageHeader, Panel, Stat } from "./components/ui";
import { PositionsTable } from "./positions/table";

export const dynamic = "force-dynamic";

export default async function Overview() {
  const [s, open, signals, logs] = await Promise.all([
    getStats(),
    db.position.findMany({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } }),
    db.signal.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
    db.runLog.findMany({ orderBy: { createdAt: "desc" }, take: 30 }),
  ]);
  const mode = (s.heartbeat?.mode ?? s.mode).toUpperCase();
  const total = s.realized + s.unrealized;

  return (
    <>
      <AutoRefresh />

      <PageHeader
        title="Overview"
        description={
          <div className="flex flex-wrap items-center gap-2">
            <Badge kind={s.workerOnline ? "up" : "down"}>{s.workerOnline ? "Worker online" : "Worker offline"}</Badge>
            <Badge kind={mode === "LIVE" ? "warn" : "accent"}>{mode} mode</Badge>
            {s.paused && <Badge kind="down">Trading paused</Badge>}
            <span>Last discovery {ago(s.lastDiscovery)}</span>
          </div>
        }
        right={
          <>
            <Button action="discover" primary>
              Run discovery
            </Button>
            {s.paused ? (
              <Button action="resume">Resume trading</Button>
            ) : (
              <Button action="pause" danger>
                Pause trading
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Total PnL" value={sol(total, true)} className={tone(total)} sub="realized + open" />
        <Stat label="Realized PnL" value={sol(s.realized, true)} className={tone(s.realized)} sub={`${s.trades} trades · ${(s.winRate * 100).toFixed(0)}% win rate`} />
        <Stat label="Today" value={sol(s.today, true)} className={tone(s.today)} sub="since 00:00 UTC" />
        <Stat label="Open PnL" value={sol(s.unrealized, true)} className={tone(s.unrealized)} sub={`${s.openCount} open positions`} />
        <Stat label="Wallets watched" value={s.watching} sub={`${s.launchers} launchers`} />
        <Stat label="Candidates" value={s.candidates} sub={`${s.excluded} filtered out`} />
        <Stat label="Signals (24h)" value={s.signals24} sub={`${s.taken24} taken`} />
      </div>

      <Panel title={`Open positions (${open.length})`}>
        {open.length ? <PositionsTable rows={open} /> : <Empty>No open positions.</Empty>}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="min-w-0 lg:col-span-3">
          <Panel title="Latest signals">
            {signals.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Coin</th>
                    <th>Reason</th>
                    <th className="r">Mcap</th>
                    <th>Decision</th>
                    <th className="r">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((g) => (
                    <tr key={g.id}>
                      <td>
                        <Coin mint={g.mint} symbol={g.symbol} />
                      </td>
                      <td className="text-mute">{g.reason}</td>
                      <td className="num r">{usd(g.mcapUsd)}</td>
                      <td>{g.decision === "TAKEN" ? <Badge kind="up">Taken</Badge> : <Badge>Skipped: {g.skipReason}</Badge>}</td>
                      <td className="r text-faint">{ago(g.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>No signals yet.</Empty>
            )}
          </Panel>
        </div>
        <div className="min-w-0 lg:col-span-2">
          <Panel title="Bot log">
            {logs.length ? (
              <table>
                <tbody>
                  {logs.map((l) => (
                    <tr key={l.id}>
                      <td className="mono w-0 text-faint">{new Date(l.createdAt).toLocaleTimeString()}</td>
                      <td className="w-0 font-medium">{l.kind}</td>
                      <td className="whitespace-normal text-mute">{l.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>No log entries. Start the worker with npm run worker.</Empty>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
