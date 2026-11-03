import type { Position } from "@/generated/prisma/client";
import { ago, sol, tone } from "@/lib/fmt";
import { Button } from "../components/Controls";
import { Addr, Badge } from "../components/ui";

export function PositionsTable({ rows }: { rows: Position[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Coin</th>
          <th>Mode</th>
          <th>Size</th>
          <th>Gain</th>
          <th>PnL</th>
          <th>TP hit</th>
          <th>Triggered by</th>
          <th>Opened</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const value = p.realizedSol + p.remainingTokens * p.currentPriceSol;
          const pnl = value - p.sizeSol;
          const gain = (p.currentPriceSol / p.entryPriceSol - 1) * 100;
          return (
            <tr key={p.id}>
              <td>
                <a href={`https://pump.fun/coin/${p.mint}`} target="_blank" rel="noreferrer" className="hover:text-up">
                  {p.symbol ?? p.mint.slice(0, 6)}
                </a>
              </td>
              <td>
                <Badge kind={p.mode === "LIVE" ? "warn" : "mute"}>{p.mode}</Badge>
              </td>
              <td>{sol(p.sizeSol)}</td>
              <td className={tone(gain)}>{p.status === "OPEN" ? `${gain >= 0 ? "+" : ""}${gain.toFixed(0)}%` : "—"}</td>
              <td className={tone(pnl)}>{sol(pnl, true)}</td>
              <td>{p.tpHit}</td>
              <td className="space-x-2">
                {p.triggerWallets.slice(0, 3).map((w) => (
                  <Addr key={w} a={w} />
                ))}
                {p.triggerWallets.length > 3 && <span className="text-mute">+{p.triggerWallets.length - 3}</span>}
              </td>
              <td className="text-mute">{ago(p.openedAt)}</td>
              <td>{p.status === "OPEN" ? <Badge kind="up">open</Badge> : <span className="text-mute">{p.exitReason}</span>}</td>
              <td>
                {p.status === "OPEN" && (
                  <Button action="close" extra={{ positionId: p.id }} danger>
                    Close
                  </Button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
