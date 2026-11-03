import { db } from "@/lib/db";
import { ago, sol, tone, usd } from "@/lib/fmt";
import { getStats } from "@/lib/stats";
import AutoRefresh from "./components/AutoRefresh";
import { Button } from "./components/Controls";
import { Badge, Empty, Panel, Stat } from "./components/ui";
import { PositionsTable } from "./positions/table";

export const dynamic = "force-dynamic";

export default async function Overview() {
  const [s, open, signals, logs] = await Promise.all([
    getStats(),
    db.position.findMany({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } }),
    db.signal.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
    db.runLog.findMany({ orderBy: { createdAt: "desc" }, take: 25 }),
  ]);
  const mode = (s.heartbeat?.mode ?? s.mode).toUpperCase();

  return (
    <>
      <AutoRefresh />
      <div className="flex flex-wrap items-center gap-3">
        <Badge kind={s.workerOnline ? "up" : "down"}>{s.workerOnline ? "● worker online" : "○ worker offline"}</Badge>
        <Badge kind={mode === "LIVE" ? "warn" : "mute"}>{mode} mode</Badge>
        {s.paused && <Badge kind="down">trading paused</Badge>}
        <span className="text-[11px] text-mute">last discovery {ago(s.lastDiscovery)}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {s.paused ? <Button action="resume">Resume trading</Button> : <Button action="pause" danger>Pause trading</Button>}
          <Button action="discover">Run discovery now</Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <Stat label="Realized PnL" value={sol(s.realized, true)} className={tone(s.realized)} sub={`${s.trades} trades · ${(s.winRate * 100).toFixed(0)}% win`} />
        <Stat label="Today" value={sol(s.today, true)} className={tone(s.today)} />
        <Stat label="Open PnL" value={sol(s.unrealized, true)} className={tone(s.unrealized)} sub={`${s.openCount} open`} />
        <Stat label="Watching" value={s.watching} sub={`${s.launchers} launchers`} />
        <Stat label="Candidates" value={s.candidates} sub={`${s.excluded} filtered out`} />
        <Stat label="Signals 24h" value={s.signals24} sub={`${s.taken24} taken`} />
      </div>

      <Panel title="Open positions">
        {open.length ? <PositionsTable rows={open} /> : <Empty>No open positions. The bot is watching.</Empty>}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Latest signals">
          {signals.length ? (
            <table>
              <tbody>
                {signals.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <a href={`https://pump.fun/coin/${g.mint}`} target="_blank" rel="noreferrer" className="hover:text-up">
                        {g.symbol ?? g.mint.slice(0, 6)}
                      </a>
                    </td>
                    <td className="text-mute">{g.reason}</td>
                    <td>{usd(g.mcapUsd)}</td>
                    <td>{g.decision === "TAKEN" ? <Badge kind="up">taken</Badge> : <span className="text-mute">{g.skipReason}</span>}</td>
                    <td className="text-mute">{ago(g.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>No signals yet.</Empty>
          )}
        </Panel>
        <Panel title="Bot log">
          {logs.length ? (
            <div className="max-h-[420px] overflow-y-auto px-4 py-2 text-[12px] leading-6">
              {logs.map((l) => (
                <div key={l.id} className="truncate">
                  <span className="text-mute">{new Date(l.createdAt).toLocaleTimeString()}</span>{" "}
                  <span className="text-warn">[{l.kind}]</span> {l.message}
                </div>
              ))}
            </div>
          ) : (
            <Empty>Start the worker with npm run worker.</Empty>
          )}
        </Panel>
      </div>
    </>
  );
}
