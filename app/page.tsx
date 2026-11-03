import { db } from "@/lib/db";
import { ago, sol, tone, usd } from "@/lib/fmt";
import { getStats } from "@/lib/stats";
import AutoRefresh from "./components/AutoRefresh";
import { Button } from "./components/Controls";
import { Badge, Coin, Empty, Panel, Stat } from "./components/ui";
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

      {/* Hero */}
      <section className="glass glass-strong overflow-hidden px-6 py-7 md:px-8 md:py-9">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent/25 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge kind={s.workerOnline ? "up" : "down"}>
                {s.workerOnline ? <span className="pulse" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                {s.workerOnline ? "Worker online" : "Worker offline"}
              </Badge>
              <Badge kind={mode === "LIVE" ? "warn" : "accent"}>{mode} mode</Badge>
              {s.paused && <Badge kind="down">Trading paused</Badge>}
              <Badge>Solana · pump.fun</Badge>
            </div>
            <div className="mt-6 text-[12px] font-medium uppercase tracking-[0.12em] text-faint">Total PnL</div>
            <div className={`num mt-1 text-[44px] font-semibold leading-none tracking-tight md:text-[56px] ${tone(total)}`}>
              {sol(total, true)}
            </div>
            <div className="mt-3 text-mute">
              Watching <span className="num text-ink">{s.watching}</span> smart wallets ·{" "}
              <span className="num text-ink">{s.launchers}</span> launchers · last discovery {ago(s.lastDiscovery)}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
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
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Realized" value={sol(s.realized, true)} className={tone(s.realized)} sub={`${s.trades} trades · ${(s.winRate * 100).toFixed(0)}% win`} />
        <Stat label="Today" value={sol(s.today, true)} className={tone(s.today)} sub="resets 00:00 UTC" />
        <Stat label="Open PnL" value={sol(s.unrealized, true)} className={tone(s.unrealized)} sub={`${s.openCount} open`} />
        <Stat label="Watching" value={s.watching} sub={`${s.launchers} launchers`} />
        <Stat label="Candidates" value={s.candidates} sub={`${s.excluded} filtered out`} />
        <Stat label="Signals 24h" value={s.signals24} sub={`${s.taken24} taken`} />
      </div>

      <Panel title="Open positions" right={<span className="num text-[12px] text-faint">{open.length}</span>}>
        {open.length ? <PositionsTable rows={open} /> : <Empty>No open positions. The bot is watching.</Empty>}
      </Panel>

      <div className="grid gap-5 lg:grid-cols-5">
        <div className="min-w-0 lg:col-span-3">
          <Panel title="Latest signals">
            {signals.length ? (
              <table>
                <tbody>
                  {signals.map((g) => (
                    <tr key={g.id}>
                      <td>
                        <Coin mint={g.mint} symbol={g.symbol} />
                      </td>
                      <td className="text-mute">{g.reason}</td>
                      <td className="num">{usd(g.mcapUsd)}</td>
                      <td>{g.decision === "TAKEN" ? <Badge kind="up">taken</Badge> : <Badge>{g.skipReason}</Badge>}</td>
                      <td className="text-faint">{ago(g.createdAt)}</td>
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
          <Panel title="Bot log" right={<span className="pulse text-up" />}>
            {logs.length ? (
              <div className="num max-h-[440px] space-y-0.5 overflow-y-auto px-4 pb-2 text-[11.5px] leading-6">
                {logs.map((l) => (
                  <div key={l.id} className="truncate">
                    <span className="text-faint">{new Date(l.createdAt).toLocaleTimeString()}</span>{" "}
                    <span className="text-accent">{l.kind}</span> <span className="text-ink/80">{l.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty>Start the worker with npm run worker.</Empty>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
