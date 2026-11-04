import type { Position } from "@/generated/prisma/client";
import { config } from "@/lib/config";
import { ago, strategyLabel, tone } from "@/lib/fmt";
import { Money } from "../components/Money";
import { Button } from "../components/Controls";
import { CardLink, RowLink } from "../components/RowLink";
import { Addr, Badge, Coin } from "../components/ui";

const signedPct = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v) || 0}%`;

function derive(p: Position) {
  const pnl = p.realizedSol + p.remainingTokens * p.currentPriceSol - p.sizeSol;
  return {
    pnl,
    pnlPct: p.sizeSol ? (pnl / p.sizeSol) * 100 : 0,
    gain: (p.currentPriceSol / p.entryPriceSol - 1) * 100,
    open: p.status === "OPEN",
    levels: (p.strategy === "migration" ? config.migrationTpLevels : p.strategy === "launch" ? config.launchSellLadder : config.tpLevels).length,
  };
}

function TpPips({ hit, levels }: { hit: number; levels: number }) {
  return (
    <span
      className="inline-flex gap-0.5"
      title={`${hit} of ${levels} take-profit levels hit`}
    >
      {Array.from({ length: Math.max(levels, hit) }, (_, i) => (
        <span
          key={i}
          className={`h-3 w-1 rounded-full ${i < hit ? "bg-up" : "bg-line-strong"}`}
        />
      ))}
    </span>
  );
}

export function CloseButton({ p }: { p: Position }) {
  const name = p.symbol ?? "this position";
  return (
    <Button
      action="close"
      extra={{ positionId: p.id }}
      danger
      small
      done={`Closing ${name}…`}
      confirm={{
        title: `Close ${name}?`,
        body: "The worker will sell the remaining tokens at market on its next check.",
        confirmLabel: "Close position",
      }}
    >
      Close
    </Button>
  );
}

export const StrategyTag = ({ p }: { p: Position }) => (
  <span className="flex items-center gap-2">
    <span className="text-mute">
      {strategyLabel(p.strategy)}
    </span>
    <Badge kind={p.mode === "LIVE" ? "warn" : "mute"}>
      {p.mode === "LIVE" ? "Live" : "Paper"}
    </Badge>
  </span>
);

export function PositionsTable({ rows }: { rows: Position[] }) {
  return (
    <>
      {/* Phones: one card per position */}
      <ul className="divide-y divide-line md:hidden">
        {rows.map((p) => {
          const d = derive(p);
          return (
            <CardLink key={p.id} href={`/positions/${p.id}`} className="space-y-2.5 px-4 py-3.5 hover:bg-raised">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <Coin mint={p.mint} symbol={p.symbol} href={`/positions/${p.id}`} />
                  <div className="pl-8 text-[12px]">
                    <StrategyTag p={p} />
                  </div>
                </div>
                <div className="text-right">
                  <div className={`num text-[14px] font-medium ${tone(d.pnl)}`}>
                    <Money v={d.pnl} signed />
                  </div>
                  <div
                    className={`num text-[11.5px] ${tone(d.pnl)} opacity-70`}
                  >
                    {signedPct(d.pnlPct)}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-8 text-[12px] text-faint">
                <span>
                  Size <span className="num text-mute"><Money v={p.sizeSol} /></span>
                </span>
                {d.open && (
                  <span>
                    Move{" "}
                    <span className={`num ${tone(d.gain)}`}>
                      {signedPct(d.gain)}
                    </span>
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  TP <TpPips hit={p.tpHit} levels={d.levels} />
                </span>
                <span>{ago(p.openedAt)}</span>
              </div>
              <div className="flex items-center justify-between gap-3 pl-8">
                {d.open ? (
                  <Badge kind="up" dot>
                    Open
                  </Badge>
                ) : (
                  <span className="min-w-0 truncate text-[12px] text-mute">
                    {p.exitReason}
                  </span>
                )}
                {d.open && <CloseButton p={p} />}
              </div>
            </CardLink>
          );
        })}
      </ul>

      {/* Tablet and up: table */}
      <table className="hidden md:table">
        <thead>
          <tr>
            <th>Coin</th>
            <th>Strategy</th>
            <th>Size</th>
            <th>Price move</th>
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
            const d = derive(p);
            return (
              <RowLink key={p.id} href={`/positions/${p.id}`}>
                <td>
                  <Coin mint={p.mint} symbol={p.symbol} href={`/positions/${p.id}`} />
                </td>
                <td>
                  <StrategyTag p={p} />
                </td>
                <td className="num text-mute"><Money v={p.sizeSol} /></td>
                <td className={`num ${d.open ? tone(d.gain) :"text-faint"}`}>
                  {d.open ? signedPct(d.gain) : "—"}
                </td>
                <td>
                  <div className={`num font-medium ${tone(d.pnl)}`}>
                    <Money v={d.pnl} signed />
                  </div>
                  <div className={`num text-[11px] ${tone(d.pnl)} opacity-70`}>
                    {signedPct(d.pnlPct)}
                  </div>
                </td>
                <td className="num">
                  <TpPips hit={p.tpHit} levels={d.levels} />
                </td>
                <td>
                  {!p.triggerWallets.length && (
                    <span className="text-faint">—</span>
                  )}
                  {p.triggerWallets.slice(0, 3).map((w) => (
                    <Addr key={w} a={w} />
                  ))}
                  {p.triggerWallets.length > 3 && (
                    <span className="ml-1 text-[12px] text-faint">
                      +{p.triggerWallets.length - 3}
                    </span>
                  )}
                </td>
                <td className="text-faint">{ago(p.openedAt)}</td>
                <td>
                  {d.open ? (
                    <Badge kind="up" dot>
                      Open
                    </Badge>
                  ) : (
                    <span className="text-[12.5px] text-mute">
                      {p.exitReason}
                    </span>
                  )}
                </td>
                <td className="act">{d.open && <CloseButton p={p} />}</td>
              </RowLink>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
