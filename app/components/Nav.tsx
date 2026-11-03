"use client";
import { Activity, ArrowLeftRight, Gauge, LayoutDashboard, Radar, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  ["/", "Overview", LayoutDashboard],
  ["/positions", "Positions", ArrowLeftRight],
  ["/signals", "Signals", Radar],
  ["/wallets", "Wallets", Wallet],
  ["/performance", "Performance", Gauge],
] as const;

type Status = { online: boolean; paused: boolean; at: string | null };

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-accent to-[#5b63d6] text-[13px] font-bold text-white shadow-[0_0_20px_-4px] shadow-accent/60">
        C
      </span>
      <span className="text-[15px] font-semibold tracking-tight">Coinbit</span>
    </Link>
  );
}

function StatusPill({ status }: { status: Status }) {
  const [color, label] = !status.online
    ? ["bg-down", "Worker offline"]
    : status.paused
      ? ["bg-warn", "Trading paused"]
      : ["bg-up", "Worker online"];
  return (
    <div className="flex items-center gap-2 text-[12px] text-mute">
      <span className="relative flex size-2">
        {status.online && !status.paused && <span className={`live-dot absolute inset-0 rounded-full ${color} opacity-60 blur-[3px]`} />}
        <span className={`relative size-2 rounded-full ${color}`} />
      </span>
      {label}
    </div>
  );
}

export default function Nav({ status }: { status: Status }) {
  const path = usePathname();
  const isActive = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-panel md:flex">
        <div className="flex h-16 items-center px-5">
          <Logo />
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-3 pt-2">
          {nav.map(([href, label, Icon]) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                className={`group flex h-9 items-center gap-3 rounded-lg px-3 text-[13px] transition-colors ${
                  active ? "bg-raised font-medium text-ink" : "text-faint hover:bg-raised/60 hover:text-ink"
                }`}
              >
                <Icon size={16} strokeWidth={active ? 2.2 : 1.8} className={active ? "text-accent" : ""} />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="space-y-1 border-t border-line px-5 py-4">
          <StatusPill status={status} />
          <div className="flex items-center gap-1.5 pl-4 text-[11px] text-faint">
            <Activity size={11} />
            pump.fun · Solana
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-20 border-b border-line bg-panel/90 backdrop-blur md:hidden">
        <div className="flex h-14 items-center justify-between px-4">
          <Logo />
          <StatusPill status={status} />
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
          {nav.map(([href, label, Icon]) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-[12.5px] ${
                  active ? "bg-raised font-medium text-ink" : "text-faint"
                }`}
              >
                <Icon size={14} />
                {label}
              </Link>
            );
          })}
        </nav>
      </header>
    </>
  );
}
