import Link from "next/link";
import { db } from "@/lib/db";
import { ago, usd } from "@/lib/fmt";
import AutoRefresh from "../components/AutoRefresh";
import { Addr, Badge, Coin, Empty, PageHeader, Panel } from "../components/ui";

export const dynamic = "force-dynamic";

const pct = (v: number | null) => (v != null ? `${v.toFixed(0)}%` : "—");

const TABS = [
  ["all", "All"],
  ["copy", "Copy trading"],
  ["migration", "Migration"],
] as const;

export default async function Signals({ searchParams }: { searchParams: Promise<{ s?: string }> }) {
  const { s: raw } = await searchParams;
  const tab = TABS.some(([t]) => t === raw) ? raw! : "all";
  const signals = await db.signal.findMany({
    where: tab === "all" ? {} : { strategy: tab },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return (
    <>
      <AutoRefresh />
      <PageHeader title="Signals" description="Every opportunity each strategy looked at, and whether it was taken or skipped (and why)." />
      <div className="flex gap-6 border-b border-line">
        {TABS.map(([t, label]) => (
          <Link
            key={t}
            href={`/signals?s=${t}`}
            className={`-mb-px border-b-2 pb-2 text-[14px] ${t === tab ? "border-accent font-medium text-ink" : "border-transparent text-faint hover:text-ink"}`}
          >
            {label}
          </Link>
        ))}
      </div>
      <Panel title={`Recent signals (${signals.length})`}>
        {signals.length ? (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Strategy</th>
                <th>Coin</th>
                <th>Reason</th>
                <th>Wallets</th>
                <th className="r">Mcap</th>
                <th className="r">Age</th>
                <th className="r">Top 10</th>
                <th className="r">Dev</th>
                <th className="r">Snipers</th>
                <th className="r">Curve</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((g) => (
                <tr key={g.id}>
                  <td className="text-faint">{ago(g.createdAt)}</td>
                  <td>
                    <Badge kind={g.strategy === "migration" ? "warn" : "accent"}>{g.strategy === "migration" ? "Migration" : "Copy"}</Badge>
                  </td>
                  <td>
                    <Coin mint={g.mint} symbol={g.symbol} />
                  </td>
                  <td className="text-mute">{g.reason}</td>
                  <td className="space-x-2">
                    {g.wallets.slice(0, 4).map((w) => (
                      <Addr key={w} a={w} />
                    ))}
                  </td>
                  <td className="num r">{usd(g.mcapUsd)}</td>
                  <td className="num r">{g.ageMin != null ? `${Math.round(g.ageMin)}m` : "—"}</td>
                  <td className="num r">{pct(g.top10Pct)}</td>
                  <td className="num r">{pct(g.devHoldPct)}</td>
                  <td className="num r">{pct(g.snipePct)}</td>
                  <td className="num r">{pct(g.curvePct)}</td>
                  <td>{g.decision === "TAKEN" ? <Badge kind="up">Taken</Badge> : <Badge>Skipped: {g.skipReason}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No signals yet.</Empty>
        )}
      </Panel>
    </>
  );
}
