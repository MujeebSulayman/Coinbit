import type { Position } from "@/generated/prisma/client";
import { config } from "@/lib/config";
import { ago, sol, tone } from "@/lib/fmt";
import { Button } from "../components/Controls";
import { Addr, Badge, Coin } from "../components/ui";

const signedPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`;

export function PositionsTable({ rows }: { rows: Position[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Coin</th>
          <th>Strategy</th>
          <th className="r">Size</th>
          <th className="r">Price move</th>
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
          const pnlPct = p.sizeSol ? (pnl / p.sizeSol) * 100 : 0;
          const gain = (p.currentPriceSol / p.entryPriceSol - 1) * 100;
          const open = p.status === "OPEN";
          const levels = (p.strategy === "migration" ? config.migrationTpLevels : config.tpLevels).length;
          return (
            <tr key={p.id}>
              <td>
                <Coin mint={p.mint} symbol={p.symbol} />
              </td>
              <td>
                <div className="flex items-center gap-2">
                  <span className="text-mute">{p.strategy === "migration" ? "Migration" : "Copy"}</span>
                  <Badge kind={p.mode === "LIVE" ? "warn" : "mute"}>{p.mode === "LIVE" ? "Live" : "Paper"}</Badge>
                </div>
              </td>
              <td className="num r text-mute">{sol(p.sizeSol)}</td>
              <td className={`num r ${open ? tone(gain) : "text-faint"}`}>{open ? signedPct(gain) : "—"}</td>
              <td className="r">
                <div className={`num font-medium ${tone(pnl)}`}>{sol(pnl, true)}</div>
                <div className={`num text-[11px] ${tone(pnl)} opacity-70`}>{signedPct(pnlPct)}</div>
              </td>
              <td className="num r">
                <span className="inline-flex gap-0.5" title={`${p.tpHit} take-profit levels hit`}>
                  {Array.from({ length: Math.max(levels, p.tpHit) }, (_, i) => (
                    <span key={i} className={`h-3 w-1 rounded-full ${i < p.tpHit ? "bg-up" : "bg-line-strong"}`} />
                  ))}
                </span>
              </td>
              <td>
                {!p.triggerWallets.length && <span className="text-faint">—</span>}
                {p.triggerWallets.slice(0, 3).map((w) => (
                  <Addr key={w} a={w} />
                ))}
                {p.triggerWallets.length > 3 && <span className="ml-1 text-[12px] text-faint">+{p.triggerWallets.length - 3}</span>}
              </td>
              <td className="text-faint">{ago(p.openedAt)}</td>
              <td>
                {open ? (
                  <Badge kind="up" dot>
                    Open
                  </Badge>
                ) : (
                  <span className="text-[12.5px] text-mute">{p.exitReason}</span>
                )}
              </td>
              <td className="r">
                {open && (
                  <Button action="close" extra={{ positionId: p.id }} danger small confirmText={`Close ${p.symbol ?? "this position"} now?`}>
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
