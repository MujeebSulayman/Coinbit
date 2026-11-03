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
    <header className="sticky top-0 z-20 border-b border-line bg-white">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-8 px-4 md:px-6">
        <Link href="/" className="text-[16px] font-semibold tracking-tight">
          Coinbit
        </Link>
        <nav className="flex h-full gap-6 overflow-x-auto">
          {nav.map(([href, label]) => {
            const active = href === "/" ? path === "/" : path.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center whitespace-nowrap border-b-2 text-[14px] ${
                  active ? "border-accent font-medium text-ink" : "border-transparent text-faint hover:text-ink"
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
