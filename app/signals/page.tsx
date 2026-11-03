import { Radar } from "lucide-react";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { ago, usd } from "@/lib/fmt";
import AutoRefresh from "../components/AutoRefresh";
import {
  Addr,
  Badge,
  Coin,
  Empty,
  Meter,
  PageHeader,
  Panel,
  Tabs,
} from "../components/ui";

export const dynamic = "force-dynamic";

const TABS = [
  ["all", "All"],
  ["copy", "Copy trading"],
  ["migration", "Migration"],
] as const;

const DECISIONS = [
  ["any", "Any decision"],
  ["TAKEN", "Taken"],
  ["SKIPPED", "Skipped"],
] as const;

const ret = (v: number | null) =>
  v == null ? (
    <span className="text-faint">—</span>
  ) : (
    <span
      className={v > 0 ? "text-up" : v < 0 ? "text-down" : "text-mute"}
    >{`${v > 0 ? "+" : ""}${Math.round(v) || 0}%`}</span>
  );

export default async function Signals({
  searchParams,
}: {
  searchParams: Promise<{ s?: string; d?: string }>;
}) {
  const { s: rawS, d: rawD } = await searchParams;
  const tab = TABS.some(([t]) => t === rawS) ? rawS! : "all";
  const dec = DECISIONS.some(([t]) => t === rawD) ? rawD! : "any";
  const signals = await db.signal.findMany({
    where: {
      ...(tab === "all" ? {} : { strategy: tab }),
      ...(dec === "any" ? {} : { decision: dec }),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const href = (s: string, d: string) => `/signals?s=${s}&d=${d}`;

  return (
    <>
      <AutoRefresh />
      <PageHeader
        title="Signals"
        description="Every opportunity each strategy looked at, whether it was taken or skipped (and why), and what the price did afterwards."
      />
      <div className="flex flex-wrap gap-2">
        <Tabs
          active={tab}
          items={TABS.map(([k, label]) => ({
            key: k,
            label,
            href: href(k, dec),
          }))}
        />
        <Tabs
          active={dec}
          items={DECISIONS.map(([k, label]) => ({
            key: k,
            label,
            href: href(tab, k),
          }))}
        />
      </div>
      <Panel title="Recent signals" count={signals.length}>
        {signals.length ? (
          <>
            <ul className="divide-y divide-line md:hidden">
              {signals.map((g) => (
                <li key={g.id} className="space-y-2 px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Coin mint={g.mint} symbol={g.symbol} href={g.positionId ? `/positions/${g.positionId}` : undefined} />
                        <Badge>
                          {g.strategy === "migration" ? "Migration" : "Copy"}
                        </Badge>
                      </div>
                      <div className="mt-0.5 truncate pl-8 text-[11.5px] text-faint">
                        {g.reason}
                      </div>
                    </div>
                    <span className="shrink-0 text-[11.5px] text-faint">
                      {ago(g.createdAt)}
                    </span>
                  </div>
                  <div className="pl-8">
                    {g.decision === "TAKEN" ? (
                      <Badge kind="up" dot>
                        Taken
                      </Badge>
                    ) : (
                      <span className="text-[12px] text-faint">
                        Skipped · {g.skipReason}
                      </span>
                    )}
                  </div>
                  <dl className="grid grid-cols-4 gap-2 pl-8 text-[11.5px]">
                    {(
                      [
                        [
                          "Mcap",
                          <span key="m" className="num">
                            {usd(g.mcapUsd)}
                          </span>,
                        ],
                        [
                          "Age",
                          <span key="a" className="num">
                            {g.ageMin != null
                              ? `${Math.round(g.ageMin)}m`
                              : "—"}
                          </span>,
                        ],
                        [
                          "+15m",
                          <span key="1" className="num">
                            {ret(g.ret15)}
                          </span>,
                        ],
                        [
                          "+60m",
                          <span key="6" className="num">
                            {ret(g.ret60)}
                          </span>,
                        ],
                      ] as const
                    ).map(([l, v]) => (
                      <div key={l} className="min-w-0">
                        <dt className="text-faint">{l}</dt>
                        <dd className="truncate">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 pl-8 text-[11.5px] text-faint">
                    {(
                      [
                        ["Top 10", g.top10Pct, config.maxTop10HolderPct],
                        ["Dev", g.devHoldPct, config.maxDevHoldPct],
                        ["Snipers", g.snipePct, config.maxLaunchSnipePct],
                        ["Curve", g.curvePct, undefined],
                      ] as const
                    ).map(([l, v, warn]) => (
                      <span
                        key={l}
                        className="inline-flex items-center gap-1.5"
                      >
                        {l} <Meter pct={v} warnAt={warn} />
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <table className="hidden md:table">
              <thead>
                <tr>
                  <th>Coin</th>
                  <th>Decision</th>
                  <th>Wallets</th>
                  <th>Mcap</th>
                  <th>Age</th>
                  <th>Top 10</th>
                  <th>Dev</th>
                  <th>Snipers</th>
                  <th>Curve</th>
                  <th>+15m</th>
                  <th>+60m</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <div className="flex items-center gap-2">
                        <Coin mint={g.mint} symbol={g.symbol} href={g.positionId ? `/positions/${g.positionId}` : undefined} />
                        <Badge>
                          {g.strategy === "migration" ? "Migration" : "Copy"}
                        </Badge>
                      </div>
                      <div
                        className="mt-0.5 max-w-80 truncate pl-8 text-[11.5px] text-faint"
                        title={g.reason}
                      >
                        {g.reason}
                      </div>
                    </td>
                    <td>
                      {g.decision === "TAKEN" ? (
                        <Badge kind="up" dot>
                          Taken
                        </Badge>
                      ) : (
                        <span
                          className="block max-w-56 truncate text-[12px] text-faint"
                          title={g.skipReason ?? ""}
                        >
                          Skipped · {g.skipReason}
                        </span>
                      )}
                    </td>
                    <td>
                      {g.wallets.slice(0, 3).map((w) => (
                        <Addr key={w} a={w} />
                      ))}
                      {g.wallets.length > 3 && (
                        <span className="ml-1 text-[12px] text-faint">
                          +{g.wallets.length - 3}
                        </span>
                      )}
                    </td>
                    <td className="num">{usd(g.mcapUsd)}</td>
                    <td className="num text-mute">
                      {g.ageMin != null ? `${Math.round(g.ageMin)}m` : "—"}
                    </td>
                    <td>
                      <Meter
                        pct={g.top10Pct}
                        warnAt={config.maxTop10HolderPct}
                      />
                    </td>
                    <td>
                      <Meter pct={g.devHoldPct} warnAt={config.maxDevHoldPct} />
                    </td>
                    <td>
                      <Meter
                        pct={g.snipePct}
                        warnAt={config.maxLaunchSnipePct}
                      />
                    </td>
                    <td>
                      <Meter pct={g.curvePct} />
                    </td>
                    <td className="num">{ret(g.ret15)}</td>
                    <td className="num">{ret(g.ret60)}</td>
                    <td className="text-faint">{ago(g.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <Empty icon={<Radar size={18} />}>
            No signals match these filters yet.
          </Empty>
        )}
      </Panel>
    </>
  );
}
