import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import Nav from "./components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Coinbit — smart wallet copy-trader",
  description: "Automatic smart-wallet discovery and copy trading for pump.fun",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#05060a" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen">
        <div className="scene" aria-hidden>
          <div className="orb a" />
          <div className="orb b" />
          <div className="orb c" />
          <div className="grid" />
          <div className="grain" />
        </div>
        <Nav />
        <main className="mx-auto max-w-7xl overflow-x-clip space-y-5 px-4 pb-16 pt-8">{children}</main>
      </body>
    </html>
  );
}
