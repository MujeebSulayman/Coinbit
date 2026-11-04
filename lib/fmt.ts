export const short = (a: string, n = 4) => `${a.slice(0, n)}…${a.slice(-n)}`;

export const sol = (v: number, signed = false) =>
  `${signed && v > 0 ? "+" : ""}${v.toFixed(Math.abs(v) < 1 ? 4 : 2)} SOL`;

export const usd = (v: number | null | undefined) => {
  if (v === null || v === undefined) return "—";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
};

export const ago = (d: Date | string | null | undefined) => {
  if (!d) return "—";
  const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-mute");

/** Dollar amount for SOL conversions: cents below $1K, then K/M. */
export const usdAmt = (v: number, signed = false) => {
  const sign = v < 0 ? "-" : signed && v > 0 ? "+" : "";
  const a = Math.abs(v);
  const body = a >= 1e6 ? `${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `${(a / 1e3).toFixed(1)}K` : a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}$${body}`;
};
