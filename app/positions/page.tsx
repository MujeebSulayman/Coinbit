import { ArrowLeftRight, History } from "lucide-react";
import { db } from "@/lib/db";
import { sol, tone } from "@/lib/fmt";
import AutoRefresh from "../components/AutoRefresh";
import { Empty, PageHeader, Panel, Stat, StatGrid } from "../components/ui";
import { PositionsTable } from "./table";

export const dynamic = "force-dynamic";

export default async function Positions() {
  const [open, closed] = await Promise.all([
    db.position.findMany({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } }),
    db.position.findMany({ where: { status: "CLOSED" }, orderBy: { closedAt: "desc" }, take: 100 }),
  ]);
  const openPnl = open.reduce((s, p) => s + p.realizedSol + p.remainingTokens * p.currentPriceSol - p.sizeSol, 0);
  const deployed = open.reduce((s, p) => s + p.sizeSol, 0);
  const recentPnl = closed.reduce((s, p) => s + p.realizedSol - p.sizeSol, 0);
  const recentWins = closed.filter((p) => p.realizedSol > p.sizeSol).length;

  return (
    <>
      <AutoRefresh />
      <PageHeader title="Positions" description="Every trade, its exits, and the wallets that triggered it." />

      <StatGrid>
        <Stat label="Open" value={open.length} sub={`${sol(deployed)} deployed`} />
        <Stat label="Open PnL" value={sol(openPnl, true)} className={tone(openPnl)} />
        <Stat label="Last 100 closed" value={sol(recentPnl, true)} className={tone(recentPnl)} sub={`${closed.length} trades`} />
        <Stat label="Win rate · last 100" value={closed.length ? `${((recentWins / closed.length) * 100).toFixed(0)}%` : "—"} />
      </StatGrid>

      <Panel title="Open" count={open.length}>
        {open.length ? <PositionsTable rows={open} /> : <Empty icon={<ArrowLeftRight size={18} />}>No open positions.</Empty>}
      </Panel>
      <Panel title="Closed" count={closed.length} right={<span className="text-[12px] text-faint">latest 100</span>}>
        {closed.length ? <PositionsTable rows={closed} /> : <Empty icon={<History size={18} />}>No closed trades yet.</Empty>}
      </Panel>
    </>
  );
}
