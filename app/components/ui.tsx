import type { ReactNode } from "react";

export function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-md border border-line bg-panel">
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-[11px] uppercase tracking-[0.12em] text-mute">{title}</h2>
        {right}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, className = "" }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className="rounded-md border border-line bg-panel px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.12em] text-mute">{label}</div>
      <div className={`mt-1 text-xl ${className}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-mute">{sub}</div>}
    </div>
  );
}

export function Badge({ children, kind = "mute" }: { children: ReactNode; kind?: "up" | "down" | "warn" | "mute" }) {
  const c = {
    up: "border-up/40 text-up",
    down: "border-down/40 text-down",
    warn: "border-warn/40 text-warn",
    mute: "border-line text-mute",
  }[kind];
  return <span className={`inline-block rounded border px-1.5 py-px text-[11px] ${c}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-8 text-center text-mute">{children}</div>;
}

export function Addr({ a, href }: { a: string; href?: string }) {
  return (
    <a href={href ?? `https://solscan.io/account/${a}`} target="_blank" rel="noreferrer" className="hover:text-up">
      {a.slice(0, 4)}…{a.slice(-4)}
    </a>
  );
}
