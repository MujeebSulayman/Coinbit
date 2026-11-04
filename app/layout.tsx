import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import { db, getKv } from "@/lib/db";
import { solUsdPrice } from "@/lib/solprice";
import { DialogProvider } from "./components/Dialog";
import { PriceProvider } from "./components/Money";
import Nav from "./components/Nav";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "Coinbit — smart wallet copy-trader", template: "%s · Coinbit" },
  description: "Automatic smart-wallet discovery and copy trading for pump.fun",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#08090b" };

async function workerStatus() {
  const [hb, paused, openCount] = await Promise.all([
    getKv("worker:heartbeat"),
    getKv("trading:paused"),
    db.position.count({ where: { status: "OPEN" } }).catch(() => 0),
  ]);
  let at: string | null = null;
  try {
    at = hb ? (JSON.parse(hb) as { at: string }).at : null;
  } catch {}
  return { online: !!at && Date.now() - new Date(at).getTime() < 90_000, paused: paused === "true", at, openCount };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [status, solPrice] = await Promise.all([workerStatus(), solUsdPrice()]);
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen md:flex" suppressHydrationWarning>
        <PriceProvider price={solPrice}>
        <DialogProvider>
          <Nav status={status} />
          <main className="min-w-0 flex-1">
            <div className="mx-auto max-w-[1400px] space-y-4 px-3 pb-20 pt-4 sm:px-5 md:space-y-5 md:px-8 md:pt-7">{children}</div>
          </main>
        </DialogProvider>
        </PriceProvider>
      </body>
    </html>
  );
}
