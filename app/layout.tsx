import type { Metadata, Viewport } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import Nav from "./components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Coinbit — smart wallet copy-trader",
  description: "Automatic smart-wallet discovery and copy trading for pump.fun",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ffffff" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen">
        <Nav />
        <main className="mx-auto max-w-7xl space-y-6 px-4 pb-16 pt-6 md:px-6">{children}</main>
      </body>
    </html>
  );
}
