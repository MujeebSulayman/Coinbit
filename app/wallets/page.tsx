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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight">Smart wallets</h1>
          <p className="mt-1 text-mute">Found and ranked automatically. You never add wallets by hand.</p>
        </div>
        <div className="glass glass-pill inline-flex gap-0.5 p-1">
          {TABS.map((t) => (
            <Link
              key={t}
              href={`/wallets?tab=${t}`}
              className={`rounded-full px-3.5 py-1.5 text-[12.5px] capitalize transition ${
                t === tab
                  ? "bg-white/[0.12] text-ink shadow-[inset_0_1px_0_rgba(255,255,255,.25)]"
                  : "text-mute hover:text-ink"
              }`}
            >
              {t.toLowerCase()} <span className="num text-faint">{count(t)}</span>
            </Link>
          ))}
        </div>
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
                    <Badge kind={w.kind === "LAUNCHER" ? "warn" : "accent"}>{w.kind.toLowerCase()}</Badge>
                  </td>
                  <td className="num font-medium">{w.score.toFixed(1)}</td>
                  <td className="num">{w.winners}</td>
                  <td className="num">{w.launchWinners}</td>
                  <td className="num text-mute">
                    {w.winners ? `#${w.avgEntryRank.toFixed(0)} · ${w.avgEntryMin.toFixed(1)}m` : "—"}
                  </td>
                  <td className="num">{w.signalHits}</td>
                  <td className={`num ${tone(w.copyPnlSol)}`}>{w.copyPnlSol ? sol(w.copyPnlSol, true) : "—"}</td>
                  <td className="text-mute">{ago(w.lastActivity)}</td>
                  {tab === "EXCLUDED" && <td className="text-mute">{w.excludeReason}</td>}
                  <td>
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
          <Empty>Nothing here yet. Discovery runs automatically when the worker starts.</Empty>
        )}
      </Panel>
    </>
  );
}
