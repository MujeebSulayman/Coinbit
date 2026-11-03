"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  ["/", "Overview"],
  ["/wallets", "Wallets"],
  ["/signals", "Signals"],
  ["/positions", "Positions"],
] as const;

export default function Nav() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-20 px-3 pt-4">
      <div className="glass glass-pill glass-strong mx-auto flex max-w-4xl items-center gap-2 py-1.5 pl-4 pr-1.5">
        <Link href="/" className="mr-2 flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <span className="relative grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-accent to-cyan shadow-[0_0_18px_rgba(139,123,255,.7)] ring-1 ring-inset ring-white/40">
            <span className="h-2 w-2 rounded-full bg-white/90" />
          </span>
          <span className="text-gradient">coinbit</span>
        </Link>
        <nav className="flex flex-1 gap-0.5 overflow-x-auto">
          {nav.map(([href, label]) => {
            const active = href === "/" ? path === "/" : path.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] transition ${
                  active
                    ? "bg-white/[0.12] text-ink shadow-[inset_0_1px_0_rgba(255,255,255,.25),inset_0_0_0_1px_rgba(255,255,255,.08)]"
                    : "text-mute hover:bg-white/[0.05] hover:text-ink"
                }`}
              >
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
