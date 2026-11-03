import type { ReactNode } from "react";

export function PageHeader({ title, description, right }: { title: string; description?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {description && <div className="mt-1 text-faint">{description}</div>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

export function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-line bg-card">
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {right}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, className = "" }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className="rounded-lg border border-line bg-card px-4 py-3">
      <div className="text-[13px] text-faint">{label}</div>
      <div className={`num mt-1 whitespace-nowrap text-[20px] font-semibold ${className}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[12.5px] text-faint">{sub}</div>}
    </div>
  );
}

export function Badge({ children, kind = "mute" }: { children: ReactNode; kind?: "up" | "down" | "warn" | "mute" | "accent" }) {
  const c = {
    up: "bg-green-50 text-up border-green-200",
    down: "bg-red-50 text-down border-red-200",
    warn: "bg-amber-50 text-warn border-amber-200",
    accent: "bg-blue-50 text-accent border-blue-200",
    mute: "bg-gray-50 text-mute border-gray-200",
  }[kind];
  return <span className={`inline-flex items-center rounded border px-1.5 py-px text-[12px] font-medium ${c}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-faint">{children}</div>;
}

export function Addr({ a, href }: { a: string; href?: string }) {
  return (
    <a href={href ?? `https://solscan.io/account/${a}`} target="_blank" rel="noreferrer" className="mono text-link hover:underline">
      {a.slice(0, 4)}…{a.slice(-4)}
    </a>
  );
}

export function Coin({ mint, symbol }: { mint: string; symbol?: string | null }) {
  return (
    <a href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer" className="font-medium text-link hover:underline">
      {symbol ?? mint.slice(0, 6)}
    </a>
  );
}
