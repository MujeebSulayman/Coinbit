import { db } from "@/lib/db";
import { ago, usd } from "@/lib/fmt";
import AutoRefresh from "../components/AutoRefresh";
import { Addr, Badge, Coin, Empty, PageHeader, Panel } from "../components/ui";

export const dynamic = "force-dynamic";

export default async function Signals() {
  const signals = await db.signal.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  return (
    <>
      <AutoRefresh />
      <PageHeader title="Signals" description="Each time smart wallets buy a fresh coin, and whether the bot took or skipped it." />
      <Panel title={`Recent signals (${signals.length})`}>
        {signals.length ? (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Coin</th>
                <th>Reason</th>
                <th>Wallets</th>
                <th className="r">Mcap</th>
                <th className="r">Age</th>
                <th className="r">Top 10 holders</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((g) => (
                <tr key={g.id}>
                  <td className="text-faint">{ago(g.createdAt)}</td>
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
                  <td className="num r">{g.top10Pct != null ? `${g.top10Pct.toFixed(0)}%` : "—"}</td>
                  <td>{g.decision === "TAKEN" ? <Badge kind="up">Taken</Badge> : <Badge>Skipped: {g.skipReason}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No signals yet. They appear when smart wallets buy the same fresh coin.</Empty>
        )}
      </Panel>
    </>
  );
}
