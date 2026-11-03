import Link from "next/link";
import { db } from "@/lib/db";
import { ago, sol, tone } from "@/lib/fmt";
import AutoRefresh from "../components/AutoRefresh";
import { Button } from "../components/Controls";
import { Addr, Badge, Empty, PageHeader, Panel } from "../components/ui";

export const dynamic = "force-dynamic";

const TABS = [
  ["WATCHING", "Watching"],
  ["CANDIDATE", "Candidates"],
  ["EXCLUDED", "Excluded"],
] as const;

export default async function Wallets({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: raw } = await searchParams;
  const tab = TABS.some(([t]) => t === raw) ? raw! : "WATCHING";
  const [wallets, counts] = await Promise.all([
    db.wallet.findMany({ where: { status: tab }, orderBy: { score: "desc" }, take: 300 }),
    db.wallet.groupBy({ by: ["status"], _count: true }),
  ]);
  const count = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;
  const tabLabel = TABS.find(([t]) => t === tab)![1];

  return (
    <>
      <AutoRefresh ms={30_000} />
      <PageHeader title="Smart wallets" description="Found and ranked automatically by the discovery engine." />

      <div className="flex gap-6 border-b border-line">
        {TABS.map(([t, label]) => (
          <Link
            key={t}
            href={`/wallets?tab=${t}`}
            className={`-mb-px border-b-2 pb-2 text-[14px] ${
              t === tab ? "border-accent font-medium text-ink" : "border-transparent text-faint hover:text-ink"
            }`}
          >
            {label} <span className="num ml-1 rounded bg-gray-100 px-1.5 text-[12px] text-mute">{count(t)}</span>
          </Link>
        ))}
      </div>

      <Panel title={`${tabLabel} (${wallets.length})`}>
        {wallets.length ? (
          <table>
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Type</th>
                <th className="r">Score</th>
                <th className="r">Early on winners</th>
                <th className="r">Winning launches</th>
                <th className="r">Avg entry</th>
                <th className="r">Signals</th>
                <th className="r">Copy PnL</th>
                <th>Last active</th>
                {tab === "EXCLUDED" && <th>Reason</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {wallets.map((w) => (
                <tr key={w.address}>
                  <td>
                    <Addr a={w.address} href={`https://gmgn.ai/sol/address/${w.address}`} />
                  </td>
                  <td>
                    <Badge kind={w.kind === "LAUNCHER" ? "warn" : "accent"}>{w.kind === "LAUNCHER" ? "Launcher" : "Trader"}</Badge>
                  </td>
                  <td className="num r font-medium">{w.score.toFixed(1)}</td>
                  <td className="num r">{w.winners}</td>
                  <td className="num r">{w.launchWinners}</td>
                  <td className="num r text-mute">{w.winners ? `#${w.avgEntryRank.toFixed(0)} · ${w.avgEntryMin.toFixed(1)}m` : "—"}</td>
                  <td className="num r">{w.signalHits}</td>
                  <td className={`num r ${tone(w.copyPnlSol)}`}>{w.copyPnlSol ? sol(w.copyPnlSol, true) : "—"}</td>
                  <td className="text-faint">{ago(w.lastActivity)}</td>
                  {tab === "EXCLUDED" && <td className="text-mute">{w.excludeReason}</td>}
                  <td className="r">
                    {tab === "EXCLUDED" ? (
                      <Button action="unexclude" extra={{ address: w.address }} small>
                        Allow
                      </Button>
                    ) : (
                      <Button action="exclude" extra={{ address: w.address }} danger small>
                        Block
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No wallets here yet. Discovery runs automatically when the worker starts.</Empty>
        )}
      </Panel>
    </>
  );
}
