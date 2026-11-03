import { db } from "@/lib/db";
import { ago, usd } from "@/lib/fmt";
import AutoRefresh from "../components/AutoRefresh";
import { Addr, Badge, Coin, Empty, Panel } from "../components/ui";

export const dynamic = "force-dynamic";

export default async function Signals() {
  const signals = await db.signal.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  return (
    <>
      <AutoRefresh />
      <div>
        <h1 className="text-[26px] font-semibold tracking-tight">Signals</h1>
        <p className="mt-1 text-mute">Each time smart wallets move on a fresh coin, and why it was taken or skipped.</p>
      </div>
      <Panel title={`Signals (${signals.length})`}>
        {signals.length ? (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Coin</th>
                <th>Why</th>
                <th>Wallets</th>
                <th>Mcap</th>
                <th>Age</th>
                <th>Top 10</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((g) => (
                <tr key={g.id}>
                  <td className="text-mute">{ago(g.createdAt)}</td>
                  <td>
                    <Coin mint={g.mint} symbol={g.symbol} />
                  </td>
                  <td className="text-mute">{g.reason}</td>
                  <td className="space-x-1.5">
                    {g.wallets.slice(0, 4).map((w) => (
                      <Addr key={w} a={w} />
                    ))}
                  </td>
                  <td className="num">{usd(g.mcapUsd)}</td>
                  <td className="num">{g.ageMin != null ? `${Math.round(g.ageMin)}m` : "—"}</td>
                  <td className="num">{g.top10Pct != null ? `${g.top10Pct.toFixed(0)}%` : "—"}</td>
                  <td>{g.decision === "TAKEN" ? <Badge kind="up">taken</Badge> : <Badge>skip · {g.skipReason}</Badge>}</td>
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
