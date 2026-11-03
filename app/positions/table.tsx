import type { Position } from "@/generated/prisma/client";
import { ago, sol, tone } from "@/lib/fmt";
import { Button } from "../components/Controls";
import { Addr, Badge, Coin } from "../components/ui";

export function PositionsTable({ rows }: { rows: Position[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Coin</th>
          <th>Mode</th>
          <th className="r">Size</th>
          <th className="r">Gain</th>
          <th className="r">PnL</th>
          <th className="r">TP hit</th>
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
                <Coin mint={p.mint} symbol={p.symbol} />
              </td>
              <td>
                <Badge kind={p.mode === "LIVE" ? "warn" : "accent"}>{p.mode}</Badge>
              </td>
              <td className="num r">{sol(p.sizeSol)}</td>
              <td className={`num r ${tone(gain)}`}>{p.status === "OPEN" ? `${gain >= 0 ? "+" : ""}${gain.toFixed(0)}%` : "—"}</td>
              <td className={`num r font-medium ${tone(pnl)}`}>{sol(pnl, true)}</td>
              <td className="num r">{p.tpHit}/3</td>
              <td className="space-x-2">
                {p.triggerWallets.slice(0, 3).map((w) => (
                  <Addr key={w} a={w} />
                ))}
                {p.triggerWallets.length > 3 && <span className="text-faint">+{p.triggerWallets.length - 3}</span>}
              </td>
              <td className="text-faint">{ago(p.openedAt)}</td>
              <td>{p.status === "OPEN" ? <Badge kind="up">Open</Badge> : <span className="text-mute">{p.exitReason}</span>}</td>
              <td className="r">
                {p.status === "OPEN" && (
                  <Button action="close" extra={{ positionId: p.id }} danger small>
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
