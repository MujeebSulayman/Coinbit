import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  right,
}: {
  title: string;
  description?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 pb-1">
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold tracking-tight sm:text-[22px]">
          {title}
        </h1>
        {description && (
          <div className="mt-1 max-w-3xl text-[13px] text-faint">
            {description}
          </div>
        )}
      </div>
      {right && (
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto [&>*]:flex-1 sm:[&>*]:flex-none">
          {right}
        </div>
      )}
    </div>
  );
}

export function Panel({
  title,
  count,
  right,
  children,
  className = "",
}: {
  title: ReactNode;
  count?: number;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`min-w-0 overflow-hidden rounded-xl border border-line bg-panel ${className}`}
    >
      <header className="flex h-11 items-center justify-between gap-3 border-b border-line px-4">
        <h2 className="flex items-center gap-2 text-[13px] font-medium">
          {title}
          {count !== undefined && (
            <span className="num rounded-md bg-raised px-1.5 text-[11px] text-faint">
              {count}
            </span>
          )}
        </h2>
        {right}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  className = "",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className="min-w-0 bg-panel px-4 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">
        {label}
      </div>
      <div
        className={`num mt-1.5 truncate text-[19px] font-medium tracking-tight ${className}`}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 truncate text-[12px] text-faint">{sub}</div>
      )}
    </div>
  );
}

/** A row of stats sharing hairline dividers, like a terminal ticker strip. */
export function StatGrid({
  children,
  cols = "grid-cols-2 md:grid-cols-4",
}: {
  children: ReactNode;
  cols?: string;
}) {
  return (
    <div
      className={`grid gap-px overflow-hidden rounded-xl border border-line bg-line ${cols}`}
    >
      {children}
    </div>
  );
}

type Kind = "up" | "down" | "warn" | "mute" | "accent";
export function Badge({
  children,
  kind = "mute",
  dot,
}: {
  children: ReactNode;
  kind?: Kind;
  dot?: boolean;
}) {
  const c = {
    up: "bg-up/10 text-up ring-up/20",
    down: "bg-down/10 text-down ring-down/20",
    warn: "bg-warn/10 text-warn ring-warn/20",
    accent: "bg-accent/10 text-link ring-accent/25",
    mute: "bg-raised text-mute ring-line-strong",
  }[kind];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium ring-1 ring-inset ${c}`}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Empty({
  children,
  icon,
}: {
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-[13px] text-faint">
      {icon && (
        <div className="mb-1 grid size-10 place-items-center rounded-xl border border-line bg-raised text-mute">
          {icon}
        </div>
      )}
      {children}
    </div>
  );
}

export function Addr({ a, href }: { a: string; href?: string }) {
  return (
    <a
      href={href ?? `https://solscan.io/account/${a}`}
      target="_blank"
      rel="noreferrer"
      className="mono rounded px-1 py-0.5 text-mute transition-colors hover:bg-hover hover:text-ink"
    >
      {a.slice(0, 4)}…{a.slice(-4)}
    </a>
  );
}

export function Coin({
  mint,
  symbol,
}: {
  mint: string;
  symbol?: string | null;
}) {
  const label = symbol ?? mint.slice(0, 6);
  return (
    <a
      href={`https://pump.fun/coin/${mint}`}
      target="_blank"
      rel="noreferrer"
      className="group inline-flex items-center gap-2"
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-full border border-line-strong bg-raised text-[10px] font-semibold uppercase text-mute">
        {label.replace(/^\$/, "").slice(0, 2)}
      </span>
      <span className="font-medium group-hover:text-link">{label}</span>
      <ArrowUpRight
        size={12}
        className="-ml-1 text-faint opacity-0 transition-opacity group-hover:opacity-100"
      />
    </a>
  );
}

/** Segmented link tabs (state lives in the URL). */
export function Tabs({
  items,
  active,
}: {
  items: { href: string; label: string; count?: number; key: string }[];
  active: string;
}) {
  return (
    <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-line bg-panel p-0.5">
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-[12.5px] transition-colors sm:h-7 ${
            t.key === active
              ? "bg-raised font-medium text-ink shadow-sm ring-1 ring-line-strong"
              : "text-faint hover:text-ink"
          }`}
        >
          {t.label}
          {t.count !== undefined && (
            <span className="num text-[11px] text-faint">{t.count}</span>
          )}
        </Link>
      ))}
    </div>
  );
}

/** Thin horizontal meter for 0–100% values. */
export function Meter({
  pct,
  warnAt,
  className = "",
}: {
  pct: number | null;
  warnAt?: number;
  className?: string;
}) {
  if (pct == null) return <span className="text-faint">—</span>;
  const v = Math.max(0, Math.min(100, pct));
  const hot = warnAt != null && pct > warnAt;
  return (
    <span className={`inline-flex items-center justify-end gap-2 ${className}`}>
      <span className={`num ${hot ? "text-warn" : ""}`}>{pct.toFixed(0)}%</span>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-line-strong">
        <span
          className={`block h-full rounded-full ${hot ? "bg-warn" : "bg-mute"}`}
          style={{ width: `${v}%` }}
        />
      </span>
    </span>
  );
}
