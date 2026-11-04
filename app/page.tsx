import {
  ArrowLeftRight,
  Pause,
  Play,
  Radar,
  ScrollText,
  Search,
  TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { db } from "@/lib/db";
import { ago, sol, tone, usd } from "@/lib/fmt";
import { getStats } from "@/lib/stats";
import { clock, TZ_LABEL } from "@/lib/time";
import AutoRefresh from "./components/AutoRefresh";
import { Button, ModeSwitch } from "./components/Controls";
import EquityChart, { type EquityPoint } from "./components/EquityChart";
import {
  Badge,
  Coin,
  Empty,
  PageHeader,
  Panel,
  Stat,
  StatGrid,
} from "./components/ui";
import { PositionsTable } from "./positions/table";

export const dynamic = "force-dynamic";

const STRATS = [
  [
    "copy",
    "Copy trading",
    "Copies smart wallets when 2+ buy the same fresh coin.",
  ],
  [
    "migration",
    "Migration",
    "Buys graduations to PumpSwap that hold up after the first minute.",
  ],
] as const;

/** Cumulative realized PnL per closed trade, thinned to ~400 points for the chart. */
async function equityCurve(): Promise<EquityPoint[]> {
  const closed = await db.position.findMany({
    where: { status: "CLOSED" },
    orderBy: { closedAt: "asc" },
    select: { realizedSol: true, sizeSol: true, closedAt: true, symbol: true },
  });
  let cum = 0;
  const all = closed.map((p) => {
    cum += p.realizedSol - p.sizeSol;
    return {
      t: (p.closedAt ?? new Date()).toISOString(),
      v: cum,
      label: p.symbol ?? undefined,
    };
  });
  const step = Math.ceil(all.length / 400);
  return step <= 1
    ? all
    : all.filter((_, i) => i % step === 0 || i === all.length - 1);
}

const logTone = (kind: string, msg: string) =>
  /error|fail|missing/i.test(msg)
    ? "text-down"
    : kind === "trade"
      ? "text-up"
      : kind === "signal"
        ? "text-link"
        : "text-faint";

export default async function Overview() {
  const [s, open, signals, logs, curve] = await Promise.all([
    getStats(),
    db.position.findMany({
      where: { status: "OPEN" },
      orderBy: { openedAt: "desc" },
    }),
    db.signal.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
    db.runLog.findMany({ orderBy: { createdAt: "desc" }, take: 40 }),
    equityCurve(),
  ]);
  const total = s.realized + s.unrealized;

  return (
    <>
      <AutoRefresh />

      <PageHeader
        title="Overview"
        description={`Last wallet discovery ${ago(s.lastDiscovery)}.`}
        right={
          <>
            <Button
              action="discover"
              done="Discovery requested. The worker picks it up within a minute."
            >
              <Search size={14} /> Run discovery
            </Button>
            {s.paused ? (
              <Button action="resume" primary done="Trading resumed">
                <Play size={14} /> Resume trading
              </Button>
            ) : (
              <Button
                action="pause"
                danger
                done="Trading paused"
                confirm={{
                  title: "Pause trading?",
                  body: "No new positions will be opened. Open positions keep being managed (stop-loss, take-profit, exits).",
                  confirmLabel: "Pause trading",
                }}
              >
                <Pause size={14} /> Pause trading
              </Button>
            )}
          </>
        }
      />

      {s.paused && (
        <div className="flex items-start gap-3 rounded-xl border border-warn/25 bg-warn/5 px-4 py-2.5 text-[13px] text-warn">
          <Pause size={15} className="mt-0.5 shrink-0" /> Trading is paused. No
          new positions will be opened until you resume.
        </div>
      )}

      {/* Hero: total PnL + equity curve, with key figures on the side */}
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="min-w-0 overflow-hidden rounded-xl border border-line bg-panel lg:col-span-2">
          <div className="flex items-start justify-between gap-4 px-4 pt-4 sm:px-5">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-faint">
                Total PnL
              </div>
              <div
                className={`num mt-1 text-[26px] font-medium leading-none sm:text-[32px] tracking-tight ${tone(total)}`}
              >
                {sol(total, true)}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-faint">
                <span>
                  Realized{" "}
                  <span className={`num ${tone(s.realized)}`}>
                    {sol(s.realized, true)}
                  </span>
                </span>
                <span>
                  Open{" "}
                  <span className={`num ${tone(s.unrealized)}`}>
                    {sol(s.unrealized, true)}
                  </span>
                </span>
              </div>
            </div>
            <div className="hidden text-right text-[12px] text-faint sm:block">
              Cumulative realized
              <div className="num text-mute">{s.trades} trades</div>
            </div>
          </div>
          <div className="px-2 pb-2 pt-3">
            {curve.length ? (
              <EquityChart points={curve} />
            ) : (
              <Empty icon={<TrendingUp size={18} />}>
                The PnL curve appears after the first closed trade.
              </Empty>
            )}
          </div>
        </section>

        <StatGrid cols="grid-cols-2 lg:grid-cols-1">
          <Stat
            label="Today"
            value={sol(s.today, true)}
            className={tone(s.today)}
            sub={`since 00:00 ${TZ_LABEL}`}
          />
          <Stat
            label="Win rate"
            value={s.trades ? `${(s.winRate * 100).toFixed(0)}%` : "—"}
            sub={`${s.trades} closed trades`}
          />
          <Stat
            label="Open positions"
            value={s.openCount}
            sub={
              <span className={tone(s.unrealized)}>
                {sol(s.unrealized, true)} unrealized
              </span>
            }
          />
          <Stat
            label="Signals · 24h"
            value={s.signals24}
            sub={`${s.taken24} taken`}
          />
        </StatGrid>
      </div>

      <StatGrid cols="grid-cols-1 sm:grid-cols-3">
        <Stat
          label="Wallets watched"
          value={s.watching}
          sub={`${s.launchers} launchers`}
        />
        <Stat
          label="Candidates"
          value={s.candidates}
          sub="awaiting promotion"
        />
        <Stat
          label="Filtered out"
          value={s.excluded}
          sub="bots, snipers, insiders"
        />
      </StatGrid>

      {/* Strategies */}
      <div className="grid gap-4 lg:grid-cols-2">
        {STRATS.map(([key, name, desc]) => {
          const m = s.modes[key];
          const st = s.byStrategy[key];
          return (
            <section
              key={key}
              className="rounded-xl border border-line bg-panel p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 basis-56">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[14px] font-semibold">{name}</h2>
                    {m === "live" && (
                      <Badge kind="warn" dot>
                        Real SOL
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12.5px] text-faint">{desc}</p>
                </div>
                <ModeSwitch strategy={key} name={name} mode={m} />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 sm:grid-cols-4">
                {(
                  [
                    [
                      "Realized",
                      <span key="r" className={tone(st.realized)}>
                        {sol(st.realized, true)}
                      </span>,
                    ],
                    ["Trades", st.trades],
                    [
                      "Win rate",
                      st.trades ? `${(st.winRate * 100).toFixed(0)}%` : "—",
                    ],
                    ["Open", st.open],
                  ] as const
                ).map(([l, v]) => (
                  <div key={l} className="min-w-0">
                    <div className="text-[11px] text-faint">{l}</div>
                    <div className="num truncate text-[13.5px]">{v}</div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      <Panel
        title="Open positions"
        count={open.length}
        right={
          <Link
            href="/positions"
            className="text-[12px] text-faint hover:text-ink"
          >
            All positions →
          </Link>
        }
      >
        {open.length ? (
          <PositionsTable rows={open} />
        ) : (
          <Empty icon={<ArrowLeftRight size={18} />}>
            No open positions right now.
          </Empty>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-5">
        <Panel
          className="lg:col-span-3"
          title="Latest signals"
          right={
            <Link
              href="/signals"
              className="text-[12px] text-faint hover:text-ink"
            >
              All signals →
            </Link>
          }
        >
          {signals.length ? (
            <ul className="divide-y divide-line">
              {signals.map((g) => (
                <li
                  key={g.id}
                  className="flex items-center justify-between gap-4 px-4 py-2.5 transition-colors hover:bg-raised"
                >
                  <div className="min-w-0">
                    <Coin mint={g.mint} symbol={g.symbol} href={g.positionId ? `/positions/${g.positionId}` : undefined} />
                    <div
                      className="mt-0.5 truncate pl-8 text-[11.5px] text-faint"
                      title={g.reason}
                    >
                      {g.reason}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1 text-right">
                    {g.decision === "TAKEN" ? (
                      <Badge kind="up" dot>
                        Taken
                      </Badge>
                    ) : (
                      <span
                        className="block max-w-36 truncate text-[12px] text-faint sm:max-w-56"
                        title={g.skipReason ?? ""}
                      >
                        Skipped · {g.skipReason}
                      </span>
                    )}
                    <span className="text-[11.5px] text-faint">
                      <span className="num text-mute">{usd(g.mcapUsd)}</span> ·{" "}
                      {ago(g.createdAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon={<Radar size={18} />}>No signals yet.</Empty>
          )}
        </Panel>

        <Panel
          className="lg:col-span-2"
          title={
            <span className="flex items-center gap-2">
              <ScrollText size={14} className="text-faint" /> Bot log
            </span>
          }
        >
          {logs.length ? (
            <div className="mono max-h-[360px] overflow-y-auto bg-bg/40 px-4 sm:max-h-[460px] py-3 text-[11.5px] leading-[1.7]">
              {logs.map((l) => (
                <div
                  key={l.id}
                  className="flex flex-wrap gap-x-3 py-0.5 sm:flex-nowrap sm:py-0"
                >
                  <span className="shrink-0 text-faint">
                    {clock(l.createdAt)}
                  </span>
                  <span
                    className={`w-[72px] shrink-0 truncate ${logTone(l.kind, l.message)}`}
                  >
                    {l.kind}
                  </span>
                  <span className="min-w-0 basis-full break-words text-mute sm:basis-auto">
                    {l.message}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon={<ScrollText size={18} />}>
              No log entries yet. Start the worker with npm run worker.
            </Empty>
          )}
        </Panel>
      </div>
    </>
  );
}
