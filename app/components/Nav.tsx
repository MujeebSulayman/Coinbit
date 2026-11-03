"use client";
import {
  Activity,
  ArrowLeftRight,
  Gauge,
  LayoutDashboard,
  Menu,
  Radar,
  SlidersHorizontal,
  Wallet,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const nav = [
  ["/", "Overview", LayoutDashboard],
  ["/positions", "Positions", ArrowLeftRight],
  ["/signals", "Signals", Radar],
  ["/wallets", "Wallets", Wallet],
  ["/performance", "Performance", Gauge],
  ["/settings", "Settings", SlidersHorizontal],
] as const;

type Status = { online: boolean; paused: boolean; at: string | null };

const statusOf = (s: Status) =>
  !s.online
    ? (["bg-down", "Worker offline"] as const)
    : s.paused
      ? (["bg-warn", "Trading paused"] as const)
      : (["bg-up", "Worker online"] as const);

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

function Dot({ status }: { status: Status }) {
  const [color] = statusOf(status);
  return (
    <span className="relative flex size-2">
      {status.online && !status.paused && (
        <span
          className={`live-dot absolute inset-0 rounded-full ${color} opacity-60 blur-[3px]`}
        />
      )}
      <span className={`relative size-2 rounded-full ${color}`} />
    </span>
  );
}

function SidebarBody({ status, path }: { status: Status; path: string }) {
  const isActive = (href: string) =>
    href === "/" ? path === "/" : path.startsWith(href);
  return (
    <>
      <nav className="flex flex-1 flex-col gap-0.5 px-3 pt-2">
        {nav.map(([href, label, Icon]) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex h-10 items-center gap-3 rounded-lg px-3 text-[13.5px] transition-colors md:h-9 md:text-[13px] ${
                active
                  ? "bg-raised font-medium text-ink"
                  : "text-faint hover:bg-raised/60 hover:text-ink"
              }`}
            >
              <Icon
                size={16}
                strokeWidth={active ? 2.2 : 1.8}
                className={active ? "text-accent" : ""}
              />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="space-y-1 border-t border-line px-5 py-4">
        <div className="flex items-center gap-2 text-[12px] text-mute">
          <Dot status={status} />
          {statusOf(status)[1]}
        </div>
        <div className="flex items-center gap-1.5 pl-4 text-[11px] text-faint">
          <Activity size={11} />
          pump.fun · Solana
        </div>
      </div>
    </>
  );
}

export default function Nav({ status }: { status: Status }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const current = nav.find(([href]) =>
    href === "/" ? path === "/" : path.startsWith(href),
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-panel md:flex">
        <div className="flex h-16 items-center px-5">
          <Logo />
        </div>
        <SidebarBody status={status} path={path} />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-panel/85 px-3 backdrop-blur-md md:hidden">
        <button
          onClick={() => setOpen(true)}
          className="grid size-9 place-items-center rounded-lg text-mute hover:bg-raised hover:text-ink"
          aria-label="Open menu"
        >
          <Menu size={19} />
        </button>
        <Logo />
        {current && current[0] !== "/" && (
          <span className="truncate text-[13px] text-faint">
            / {current[1]}
          </span>
        )}
        <span
          className="ml-auto flex items-center gap-2 pr-1 text-[11.5px] text-faint"
          title={statusOf(status)[1]}
        >
          <Dot status={status} />
          <span className="hidden min-[400px]:inline">
            {statusOf(status)[1]}
          </span>
        </span>
      </header>

      {/* Mobile drawer */}
      {open && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <div
            className="fade-in absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <aside className="drawer-in relative flex h-full w-72 max-w-[85vw] flex-col border-r border-line bg-panel">
            <div className="flex h-14 items-center justify-between px-5">
              <Logo />
              <button
                onClick={() => setOpen(false)}
                className="grid size-9 place-items-center rounded-lg text-mute hover:bg-raised hover:text-ink"
                aria-label="Close menu"
              >
                <X size={18} />
              </button>
            </div>
            <SidebarBody status={status} path={path} />
          </aside>
        </div>
      )}
    </>
  );
}
