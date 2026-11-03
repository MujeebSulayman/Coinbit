import { db } from "@/lib/db";
import { ago, usd } from "@/lib/fmt";
import AutoRefresh from "../components/AutoRefresh";
import { Addr, Badge, Empty, Panel } from "../components/ui";

export const dynamic = "force-dynamic";

export default async function Signals() {
  const signals = await db.signal.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  return (
    <>
      <AutoRefresh />
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
                    <a href={`https://pump.fun/coin/${g.mint}`} target="_blank" rel="noreferrer" className="hover:text-up">
                      {g.symbol ?? g.mint.slice(0, 6)}
                    </a>
                  </td>
                  <td className="text-mute">{g.reason}</td>
                  <td className="space-x-2">
                    {g.wallets.slice(0, 4).map((w) => (
                      <Addr key={w} a={w} />
                    ))}
                  </td>
                  <td>{usd(g.mcapUsd)}</td>
                  <td>{g.ageMin != null ? `${Math.round(g.ageMin)}m` : "—"}</td>
                  <td>{g.top10Pct != null ? `${g.top10Pct.toFixed(0)}%` : "—"}</td>
                  <td>{g.decision === "TAKEN" ? <Badge kind="up">taken</Badge> : <span className="text-mute">skip: {g.skipReason}</span>}</td>
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
