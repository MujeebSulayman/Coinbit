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
  const total = s.realized + s.unrealized;

  return (
    <>
      <AutoRefresh />

      <PageHeader
        title="Overview"
        description={
          <div className="flex flex-wrap items-center gap-2">
            <Badge kind={s.workerOnline ? "up" : "down"}>{s.workerOnline ? "Worker online" : "Worker offline"}</Badge>
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

      <Panel title="Strategies">
        <table>
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Mode</th>
              <th className="r">Realized PnL</th>
              <th className="r">Trades</th>
              <th className="r">Win rate</th>
              <th className="r">Open</th>
              <th className="r">Switch mode</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["copy", "Copy trading", "Copies smart wallets when 2+ buy the same fresh coin"],
                ["migration", "Migration", "Buys graduations to PumpSwap that hold up after the first minute"],
              ] as const
            ).map(([key, name, desc]) => {
              const m = s.modes[key];
              const st = s.byStrategy[key];
              return (
                <tr key={key}>
                  <td className="whitespace-normal">
                    <div className="font-medium">{name}</div>
                    <div className="text-[12.5px] text-faint">{desc}</div>
                  </td>
                  <td>
                    <Badge kind={m === "live" ? "warn" : m === "paper" ? "accent" : "mute"}>{m.toUpperCase()}</Badge>
                  </td>
                  <td className={`num r ${tone(st.realized)}`}>{sol(st.realized, true)}</td>
                  <td className="num r">{st.trades}</td>
                  <td className="num r">{st.trades ? `${(st.winRate * 100).toFixed(0)}%` : "—"}</td>
                  <td className="num r">{st.open}</td>
                  <td className="r space-x-1">
                    <Button action="setMode" extra={{ strategy: key, mode: "off" }} small disabled={m === "off"}>
                      Off
                    </Button>
                    <Button action="setMode" extra={{ strategy: key, mode: "paper" }} small disabled={m === "paper"}>
                      Paper
                    </Button>
                    <Button
                      action="setMode"
                      extra={{ strategy: key, mode: "live" }}
                      small
                      danger
                      disabled={m === "live"}
                      confirmText={`Switch ${name} to LIVE? It will trade real SOL from your trading wallet.`}
                    >
                      Live
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>

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
