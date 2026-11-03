import { Wallet } from "lucide-react";
import { db } from "@/lib/db";
import { ago, sol, tone } from "@/lib/fmt";
import AutoRefresh from "../components/AutoRefresh";
import type { Wallet as WalletRow } from "@/generated/prisma/client";
import { Button } from "../components/Controls";
import { Addr, Badge, Empty, PageHeader, Panel, Tabs } from "../components/ui";

export const dynamic = "force-dynamic";

const TABS = [
  ["WATCHING", "Watching"],
  ["CANDIDATE", "Candidates"],
  ["EXCLUDED", "Excluded"],
] as const;

function Action({ w, excluded }: { w: WalletRow; excluded: boolean }) {
  return excluded ? (
    <Button
      action="unexclude"
      extra={{ address: w.address }}
      small
      done="Wallet allowed. It's back in the candidate pool."
    >
      Allow
    </Button>
  ) : (
    <Button
      action="exclude"
      extra={{ address: w.address }}
      danger
      small
      done="Wallet blocked"
      confirm={{
        title: "Block this wallet?",
        body: `${w.address.slice(0, 4)}…${w.address.slice(-4)} will stop triggering signals. You can allow it again from the Excluded tab.`,
        confirmLabel: "Block wallet",
      }}
    >
      Block
    </Button>
  );
}

/** Score bar relative to the best wallet on the page. */
function Score({ v, max }: { v: number; max: number }) {
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className="num font-medium">{v.toFixed(1)}</span>
      <span className="h-1 w-12 overflow-hidden rounded-full bg-line-strong">
        <span
          className="block h-full rounded-full bg-accent"
          style={{ width: `${max > 0 ? Math.max(4, (v / max) * 100) : 0}%` }}
        />
      </span>
    </span>
  );
}

export default async function Wallets({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab: raw } = await searchParams;
  const tab = TABS.some(([t]) => t === raw) ? raw! : "WATCHING";
  const [wallets, counts] = await Promise.all([
    db.wallet.findMany({
      where: { status: tab },
      orderBy: { score: "desc" },
      take: 300,
    }),
    db.wallet.groupBy({ by: ["status"], _count: true }),
  ]);
  const count = (s: string) => counts.find((c) => c.status === s)?._count ?? 0;
  const tabLabel = TABS.find(([t]) => t === tab)![1];
  const maxScore = Math.max(0, ...wallets.map((w) => w.score));

  return (
    <>
      <AutoRefresh ms={30_000} />
      <PageHeader
        title="Smart wallets"
        description={
          tab === "EXCLUDED"
            ? "Filtered out automatically: bots, launch snipers, insiders, or poor full-history results. Allow overrides a decision permanently."
            : "Found and ranked automatically by the discovery engine."
        }
      />

      <Tabs
        active={tab}
        items={TABS.map(([k, label]) => ({
          key: k,
          label,
          count: count(k),
          href: `/wallets?tab=${k}`,
        }))}
      />

      <Panel title={tabLabel} count={wallets.length}>
        {wallets.length ? (
          <>
            <ul className="divide-y divide-line md:hidden">
              {wallets.map((w, i) => (
                <li key={w.address} className="space-y-2.5 px-4 py-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="num w-5 text-faint">{i + 1}</span>
                      <Addr
                        a={w.address}
                        href={`https://gmgn.ai/sol/address/${w.address}`}
                      />
                      <Badge kind={w.kind === "LAUNCHER" ? "warn" : "accent"}>
                        {w.kind === "LAUNCHER" ? "Launcher" : "Trader"}
                      </Badge>
                    </div>
                    <Score v={w.score} max={maxScore} />
                  </div>
                  {tab === "EXCLUDED" && (
                    <div className="pl-7">
                      <Badge kind="down">{w.excludeReason ?? "—"}</Badge>
                    </div>
                  )}
                  <dl className="grid grid-cols-3 gap-2 pl-7 text-[12px]">
                    <div>
                      <dt className="text-faint">Early wins</dt>
                      <dd className="num">{w.winners}</dd>
                    </div>
                    <div>
                      <dt className="text-faint">History</dt>
                      <dd className="num">
                        {w.histTokens != null ? (
                          <span>
                            {((w.histWinRate ?? 0) * 100).toFixed(0)}% win
                          </span>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-faint">Copy PnL</dt>
                      <dd className={`num ${tone(w.copyPnlSol)}`}>
                        {w.copyPnlSol ? sol(w.copyPnlSol, true) : "—"}
                      </dd>
                    </div>
                  </dl>
                  <div className="flex items-center justify-between pl-7">
                    <span className="text-[12px] text-faint">
                      {w.allowed ? "Allowed manually · " : ""}active{" "}
                      {ago(w.lastActivity)}
                    </span>
                    <Action w={w} excluded={tab === "EXCLUDED"} />
                  </div>
                </li>
              ))}
            </ul>
            <table className="hidden md:table">
              <thead>
                <tr>
                  <th className="w-0 pr-0">#</th>
                  <th>Wallet</th>
                  {tab === "EXCLUDED" && <th>Why excluded</th>}
                  <th>Type</th>
                  <th className="r">Score</th>
                  <th className="r">Early on winners</th>
                  <th className="r">Winning launches</th>
                  <th className="r">Avg entry</th>
                  <th className="r">History · win · PnL · coins</th>
                  <th className="r">Signals</th>
                  <th className="r">Copy PnL</th>
                  <th>Last active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {wallets.map((w, i) => (
                  <tr key={w.address}>
                    <td className="num w-0 pr-0 text-faint">{i + 1}</td>
                    <td>
                      <Addr
                        a={w.address}
                        href={`https://gmgn.ai/sol/address/${w.address}`}
                      />
                      {w.allowed && (
                        <span className="ml-2">
                          <Badge>allowed manually</Badge>
                        </span>
                      )}
                    </td>
                    {tab === "EXCLUDED" && (
                      <td>
                        <Badge kind="down">{w.excludeReason ?? "—"}</Badge>
                      </td>
                    )}
                    <td>
                      <Badge kind={w.kind === "LAUNCHER" ? "warn" : "accent"}>
                        {w.kind === "LAUNCHER" ? "Launcher" : "Trader"}
                      </Badge>
                    </td>
                    <td className="r">
                      <Score v={w.score} max={maxScore} />
                    </td>
                    <td className="num r">{w.winners}</td>
                    <td className="num r">{w.launchWinners}</td>
                    <td className="num r text-mute">
                      {w.winners
                        ? `#${w.avgEntryRank.toFixed(0)} · ${w.avgEntryMin.toFixed(1)}m`
                        : "—"}
                    </td>
                    <td className="num r">
                      {w.histTokens != null ? (
                        <span
                          title={`Checked ${ago(w.histCheckedAt)}`}
                          className="text-mute"
                        >
                          {((w.histWinRate ?? 0) * 100).toFixed(0)}% ·{" "}
                          <span className={tone(w.histPnlSol ?? 0)}>
                            {sol(w.histPnlSol ?? 0, true)}
                          </span>{" "}
                          · {w.histTokens}
                        </span>
                      ) : (
                        <span className="text-faint">not vetted</span>
                      )}
                    </td>
                    <td className="num r">{w.signalHits}</td>
                    <td className={`num r ${tone(w.copyPnlSol)}`}>
                      {w.copyPnlSol ? sol(w.copyPnlSol, true) : "—"}
                    </td>
                    <td className="text-faint">{ago(w.lastActivity)}</td>
                    <td className="r">
                      <Action w={w} excluded={tab === "EXCLUDED"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <Empty icon={<Wallet size={18} />}>
            No wallets here yet. Discovery runs automatically when the worker
            starts.
          </Empty>
        )}
      </Panel>
    </>
  );
}
