import type { ReactNode } from "react";

export function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="glass min-w-0 overflow-hidden">
      <header className="flex items-center justify-between px-5 pb-2 pt-4">
        <h2 className="text-[13px] font-medium text-ink/90">{title}</h2>
        {right}
      </header>
      <div className="overflow-x-auto px-1 pb-2">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, className = "" }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className="glass px-5 py-4">
      <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-faint">{label}</div>
      <div className={`num mt-2 whitespace-nowrap text-[17px] font-medium leading-none tracking-tight md:text-[22px] ${className}`}>{value}</div>
      {sub && <div className="mt-2 text-[11.5px] text-mute">{sub}</div>}
    </div>
  );
}

export function Badge({ children, kind = "mute" }: { children: ReactNode; kind?: "up" | "down" | "warn" | "mute" | "accent" }) {
  const c = {
    up: "text-up bg-up/10 ring-up/25",
    down: "text-down bg-down/10 ring-down/25",
    warn: "text-warn bg-warn/10 ring-warn/25",
    accent: "text-accent bg-accent/10 ring-accent/30",
    mute: "text-mute bg-white/[0.04] ring-white/10",
  }[kind];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ring-1 ring-inset backdrop-blur ${c}`}>
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-5 py-10 text-center text-mute">{children}</div>;
}

export function Addr({ a, href }: { a: string; href?: string }) {
  return (
    <a
      href={href ?? `https://solscan.io/account/${a}`}
      target="_blank"
      rel="noreferrer"
      className="num rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[12px] text-ink/85 ring-1 ring-inset ring-white/[0.06] hover:text-cyan"
    >
      {a.slice(0, 4)}…{a.slice(-4)}
    </a>
  );
}

export function Coin({ mint, symbol }: { mint: string; symbol?: string | null }) {
  const label = symbol ?? mint.slice(0, 6);
  const hue = parseInt(mint.slice(0, 6).replace(/[^0-9a-f]/gi, "0").slice(0, 4) || "0", 16) % 360;
  return (
    <a href={`https://pump.fun/coin/${mint}`} target="_blank" rel="noreferrer" className="group inline-flex items-center gap-2">
      <span
        className="grid h-6 w-6 place-items-center rounded-full text-[10px] font-semibold text-white/90 ring-1 ring-inset ring-white/20"
        style={{ background: `linear-gradient(140deg, hsl(${hue} 80% 60% / .9), hsl(${(hue + 60) % 360} 80% 40% / .7))` }}
      >
        {label.slice(0, 1).toUpperCase()}
      </span>
      <span className="font-medium group-hover:text-cyan">{label}</span>
    </a>
  );
}
