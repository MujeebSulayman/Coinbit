import Link from "next/link";
import { db } from "@/lib/db";
import { ago, sol, tone } from "@/lib/fmt";
import AutoRefresh from "../components/AutoRefresh";
import { Button } from "../components/Controls";
import { Addr, Badge, Empty, Panel } from "../components/ui";

export const dynamic = "force-dynamic";

const TABS = ["WATCHING", "CANDIDATE", "EXCLUDED"] as const;

export default async function Wallets({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: raw } = await searchParams;
  const tab = (TABS as readonly string[]).includes(raw ?? "") ? raw! : "WATCHING";
  const [wallets, counts] = await Promise.all([
    db.wallet.findMany({ where: { status: tab }, orderBy: { score: "desc" }, take: 300 }),
    db.wallet.groupBy({ by: ["status"], _count: true }),
  ]);
  const count = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;

  return (
    <>
      <AutoRefresh ms={30_000} />
      <div className="flex gap-2">
        {TABS.map((t) => (
          <Link
            key={t}
            href={`/wallets?tab=${t}`}
            className={`rounded border px-3 py-1 text-[12px] ${t === tab ? "border-up/60 text-up" : "border-line text-mute hover:text-ink"}`}
          >
            {t.toLowerCase()} ({count(t)})
          </Link>
        ))}
      </div>
      <Panel title="Found automatically by the discovery engine">
        {wallets.length ? (
          <table>
            <thead>
              <tr>
                <th>Wallet</th>
                <th>Type</th>
                <th>Score</th>
                <th>Early on winners</th>
                <th>Winning launches</th>
                <th>Avg entry</th>
                <th>Signals</th>
                <th>Copy PnL</th>
                <th>Last active</th>
                {tab === "EXCLUDED" && <th>Why filtered</th>}
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
                    <Badge kind={w.kind === "LAUNCHER" ? "warn" : "mute"}>{w.kind.toLowerCase()}</Badge>
                  </td>
                  <td>{w.score.toFixed(1)}</td>
                  <td>{w.winners}</td>
                  <td>{w.launchWinners}</td>
                  <td className="text-mute">
                    {w.winners ? `#${w.avgEntryRank.toFixed(0)} · ${w.avgEntryMin.toFixed(1)}m` : "—"}
                  </td>
                  <td>{w.signalHits}</td>
                  <td className={tone(w.copyPnlSol)}>{w.copyPnlSol ? sol(w.copyPnlSol, true) : "—"}</td>
                  <td className="text-mute">{ago(w.lastActivity)}</td>
                  {tab === "EXCLUDED" && <td className="text-mute">{w.excludeReason}</td>}
                  <td>
                    {tab === "EXCLUDED" ? (
                      <Button action="unexclude" extra={{ address: w.address }}>
                        Allow
                      </Button>
                    ) : (
                      <Button action="exclude" extra={{ address: w.address }} danger>
                        Block
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Nothing here yet. Discovery runs automatically when the worker starts.</Empty>
        )}
      </Panel>
    </>
  );
}
