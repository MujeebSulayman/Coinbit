import { Radar } from "lucide-react";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { ago, usd } from "@/lib/fmt";
import AutoRefresh from "../components/AutoRefresh";
import { Addr, Badge, Coin, Empty, Meter, PageHeader, Panel, Tabs } from "../components/ui";

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
  v == null ? <span className="text-faint">—</span> : <span className={v > 0 ? "text-up" : v < 0 ? "text-down" : "text-mute"}>{`${v > 0 ? "+" : ""}${Math.round(v) || 0}%`}</span>;

export default async function Signals({ searchParams }: { searchParams: Promise<{ s?: string; d?: string }> }) {
  const { s: rawS, d: rawD } = await searchParams;
  const tab = TABS.some(([t]) => t === rawS) ? rawS! : "all";
  const dec = DECISIONS.some(([t]) => t === rawD) ? rawD! : "any";
  const signals = await db.signal.findMany({
    where: { ...(tab === "all" ? {} : { strategy: tab }), ...(dec === "any" ? {} : { decision: dec }) },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const href = (s: string, d: string) => `/signals?s=${s}&d=${d}`;

  return (
    <>
      <AutoRefresh />
      <PageHeader title="Signals" description="Every opportunity each strategy looked at, whether it was taken or skipped (and why), and what the price did afterwards." />
      <div className="flex flex-wrap gap-2">
        <Tabs active={tab} items={TABS.map(([k, label]) => ({ key: k, label, href: href(k, dec) }))} />
        <Tabs active={dec} items={DECISIONS.map(([k, label]) => ({ key: k, label, href: href(tab, k) }))} />
      </div>
      <Panel title="Recent signals" count={signals.length}>
        {signals.length ? (
          <table>
            <thead>
              <tr>
                <th>Coin</th>
                <th>Decision</th>
                <th>Wallets</th>
                <th className="r">Mcap</th>
                <th className="r">Age</th>
                <th className="r">Top 10</th>
                <th className="r">Dev</th>
                <th className="r">Snipers</th>
                <th className="r">Curve</th>
                <th className="r">+15m</th>
                <th className="r">+60m</th>
                <th className="r">Time</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((g) => (
                <tr key={g.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <Coin mint={g.mint} symbol={g.symbol} />
                      <Badge>{g.strategy === "migration" ? "Migration" : "Copy"}</Badge>
                    </div>
                    <div className="mt-0.5 max-w-80 truncate pl-8 text-[11.5px] text-faint" title={g.reason}>
                      {g.reason}
                    </div>
                  </td>
                  <td>
                    {g.decision === "TAKEN" ? (
                      <Badge kind="up" dot>
                        Taken
                      </Badge>
                    ) : (
                      <span className="block max-w-56 truncate text-[12px] text-faint" title={g.skipReason ?? ""}>
                        Skipped · {g.skipReason}
                      </span>
                    )}
                  </td>
                  <td>
                    {g.wallets.slice(0, 3).map((w) => (
                      <Addr key={w} a={w} />
                    ))}
                    {g.wallets.length > 3 && <span className="ml-1 text-[12px] text-faint">+{g.wallets.length - 3}</span>}
                  </td>
                  <td className="num r">{usd(g.mcapUsd)}</td>
                  <td className="num r text-mute">{g.ageMin != null ? `${Math.round(g.ageMin)}m` : "—"}</td>
                  <td className="r">
                    <Meter pct={g.top10Pct} warnAt={config.maxTop10HolderPct} />
                  </td>
                  <td className="r">
                    <Meter pct={g.devHoldPct} warnAt={config.maxDevHoldPct} />
                  </td>
                  <td className="r">
                    <Meter pct={g.snipePct} warnAt={config.maxLaunchSnipePct} />
                  </td>
                  <td className="r">
                    <Meter pct={g.curvePct} />
                  </td>
                  <td className="num r">{ret(g.ret15)}</td>
                  <td className="num r">{ret(g.ret60)}</td>
                  <td className="r text-faint">{ago(g.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty icon={<Radar size={18} />}>No signals match these filters yet.</Empty>
        )}
      </Panel>
    </>
  );
}
