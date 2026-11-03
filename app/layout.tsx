import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Coinbit — smart wallet copy-trader",
  description: "Automatic smart-wallet discovery and copy trading for pump.fun",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0b0d0c" };

const nav = [
  ["/", "Overview"],
  ["/wallets", "Wallets"],
  ["/signals", "Signals"],
  ["/positions", "Positions"],
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-up shadow-[0_0_10px] shadow-up" />
              coinbit
            </Link>
            <nav className="flex gap-1 overflow-x-auto text-mute">
              {nav.map(([href, label]) => (
                <Link key={href} href={href} className="rounded px-2.5 py-1 hover:bg-panel hover:text-ink">
                  {label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl space-y-4 px-4 py-5">{children}</main>
      </body>
    </html>
  );
}
