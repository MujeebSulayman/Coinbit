import { Suspense } from "react";
import { ArrowLeftRight, History, SearchX } from "lucide-react";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { tone } from "@/lib/fmt";
import { Money } from "../components/Money";
import AutoRefresh from "../components/AutoRefresh";
import { SearchInput } from "../components/SearchInput";
import { Empty, PageHeader, Panel, Stat, StatGrid, Tabs } from "../components/ui";
import { PositionsTable } from "./table";

export const dynamic = "force-dynamic";
export const metadata = { title: "Positions" };

const STRATEGIES = [
  ["all", "All"],
  ["copy", "Copy"],
  ["migration", "Migration"],
  ["launch", "Launch sniper"],
] as const;

const OUTCOMES = [
  ["any", "Any result"],
  ["win", "Wins"],
  ["loss", "Losses"],
] as const;

const MODES = [
  ["any", "Paper + Live"],
  ["PAPER", "Paper"],
  ["LIVE", "Live"],
] as const;

type Params = { q?: string; s?: string; o?: string; m?: string };
const pick = <T extends readonly (readonly [string, string])[]>(opts: T, raw: string | undefined) =>
  (opts.some(([k]) => k === raw) ? raw! : opts[0][0]) as T[number][0];

export default async function Positions({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const strategy = pick(STRATEGIES, sp.s);
  const outcome = pick(OUTCOMES, sp.o);
  const mode = pick(MODES, sp.m);
  const filtered = Boolean(q) || strategy !== "all" || outcome !== "any" || mode !== "any";

  const closedWhere: Prisma.PositionWhereInput = {
    status: "CLOSED",
    ...(strategy !== "all" && { strategy }),
    ...(mode !== "any" && { mode }),
    ...(outcome === "win" && { realizedSol: { gt: db.position.fields.sizeSol } }),
    ...(outcome === "loss" && { realizedSol: { lte: db.position.fields.sizeSol } }),
    ...(q && {
      OR: [
        { symbol: { contains: q, mode: "insensitive" } },
        { mint: { contains: q, mode: "insensitive" } },
        { exitReason: { contains: q, mode: "insensitive" } },
        { triggerWallets: { has: q } },
      ],
    }),
  };

  const [open, closed, matches] = await Promise.all([
    db.position.findMany({ where: { status: "OPEN" }, orderBy: { openedAt: "desc" } }),
    db.position.findMany({ where: { status: "CLOSED" }, orderBy: { closedAt: "desc" }, take: 100 }),
    filtered ? db.position.findMany({ where: closedWhere, orderBy: { closedAt: "desc" }, take: 100 }) : null,
  ]);
  const shown = matches ?? closed;
  const openPnl = open.reduce((s, p) => s + p.realizedSol + p.remainingTokens * p.currentPriceSol - p.sizeSol, 0);
  const deployed = open.reduce((s, p) => s + p.sizeSol, 0);
  const recentPnl = closed.reduce((s, p) => s + p.realizedSol - p.sizeSol, 0);
  const recentWins = closed.filter((p) => p.realizedSol > p.sizeSol).length;
  const shownPnl = shown.reduce((s, p) => s + p.realizedSol - p.sizeSol, 0);

  const href = (o: Partial<Params>) => {
    const next = new URLSearchParams();
    const v = { q, s: strategy, o: outcome, m: mode, ...o };
    if (v.q) next.set("q", v.q);
    if (v.s !== "all") next.set("s", v.s);
    if (v.o !== "any") next.set("o", v.o);
    if (v.m !== "any") next.set("m", v.m);
    const qs = next.toString();
    return qs ? `/positions?${qs}` : "/positions";
  };

  return (
    <>
      <AutoRefresh />
      <PageHeader title="Positions" description="Every trade, its exits, and the wallets that triggered it." />

      <StatGrid>
        <Stat label="Open" value={open.length} sub={<><Money v={deployed} /> deployed</>} />
        <Stat label="Open PnL" value={<Money v={openPnl} signed stack />} className={tone(openPnl)} />
        <Stat label="Last 100 closed" value={<Money v={recentPnl} signed stack />} className={tone(recentPnl)} sub={`${closed.length} trades`} />
        <Stat label="Win rate · last 100" value={closed.length ? `${((recentWins / closed.length) * 100).toFixed(0)}%` : "—"} />
      </StatGrid>

      <Panel title="Open" count={open.length}>
        {open.length ? <PositionsTable rows={open} /> : <Empty icon={<ArrowLeftRight size={18} />}>No open positions.</Empty>}
      </Panel>

      <div className="flex flex-wrap items-center gap-2">
        <Suspense>
          <SearchInput placeholder="Symbol, mint, exit reason, wallet…" />
        </Suspense>
        <Tabs scroll={false} active={strategy} items={STRATEGIES.map(([k, label]) => ({ key: k, label, href: href({ s: k }) }))} />
        <Tabs scroll={false} active={outcome} items={OUTCOMES.map(([k, label]) => ({ key: k, label, href: href({ o: k }) }))} />
        <Tabs scroll={false} active={mode} items={MODES.map(([k, label]) => ({ key: k, label, href: href({ m: k }) }))} />
      </div>

      <Panel
        title="Closed"
        count={shown.length}
        right={
          <span className="text-[12px] text-faint">
            {filtered ? (
              <>
                latest 100 matching · <span className={`num ${tone(shownPnl)}`}><Money v={shownPnl} signed /></span>
              </>
            ) : (
              "latest 100"
            )}
          </span>
        }
      >
        {shown.length ? (
          <PositionsTable rows={shown} />
        ) : filtered ? (
          <Empty icon={<SearchX size={18} />}>No closed trades match these filters.</Empty>
        ) : (
          <Empty icon={<History size={18} />}>No closed trades yet.</Empty>
        )}
      </Panel>
    </>
  );
}
