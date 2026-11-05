"use client";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Candle, CandleTf } from "@/lib/market";
import { axisTime, dateTime } from "@/lib/time";
import type { FillPt } from "./PriceChart";

const TFS: CandleTf[] = ["1m", "5m", "15m", "1h", "4h", "1d"];
const TF_SEC: Record<CandleTf, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const DEX_LABEL: Record<string, string> = { "pump-fun": "pump.fun bonding curve", pumpswap: "PumpSwap" };

/** 0.00000006465 → "0.0₇6465" (DexScreener-style zero count), otherwise 4 significant digits. */
const SUB = "₀₁₂₃₄₅₆₇₈₉";
function fmtPrice(v: number) {
  if (!v) return "0";
  if (v >= 0.001) return v.toPrecision(4);
  const zeros = Math.ceil(-Math.log10(v)) - 1;
  const digits = (v * 10 ** (zeros + 1)).toFixed(3).replace(".", "").slice(0, 4);
  return `0.0${[...String(zeros)].map((d) => SUB[+d]).join("")}${digits}`;
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Market candles for the coin (GeckoTerminal, same on-chain pump.fun trades) with this trade's
 * buys and sells marked at their fill prices and a line at the entry price.
 */
export default function MarketChart({
  mint,
  from,
  to,
  live,
  entry,
  fills: fillsProp,
}: {
  mint: string;
  from: number;
  to: number | null;
  live: boolean;
  entry: number;
  fills: FillPt[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const [tf, setTf] = useState<CandleTf>("1m");
  const [data, setData] = useState<{ candles: Candle[]; dex?: string } | null>(null);
  const [error, setError] = useState(false);
  // The page re-renders every few seconds; only redraw when the fills actually change.
  const fillsKey = JSON.stringify(fillsProp);
  const fills = useMemo(() => JSON.parse(fillsKey) as FillPt[], [fillsKey]);

  // Fetch (and, while the position is open, refresh every 30s).
  useEffect(() => {
    let stop = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const qs = new URLSearchParams({ mint, from: String(from), tf, ...(to ? { to: String(to) } : {}) });
        const r = await fetch(`/api/candles?${qs}`);
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (!stop) {
          setData({ candles: j.candles ?? [], dex: j.dex });
          setError(false);
        }
      } catch {
        // Usually GeckoTerminal's free-tier rate limit: back off and try again.
        if (!stop) {
          setError(true);
          clearTimeout(retry);
          retry = setTimeout(load, 15_000);
        }
      }
    };
    setData(null);
    load();
    const id = live ? setInterval(load, 30_000) : undefined;
    return () => {
      stop = true;
      clearInterval(id);
      clearTimeout(retry);
    };
  }, [mint, from, to, tf, live]);

  // Draw.
  const framed = useRef<string>("");
  const kept = useRef<{ from: UTCTimestamp; to: UTCTimestamp } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || !data?.candles.length) return;
    const up = cssVar("--color-up") || "#34d399";
    const down = cssVar("--color-down") || "#f87171";
    const faint = cssVar("--color-faint") || "#6c737e";
    const line = cssVar("--color-line") || "#1e2228";
    const ink = cssVar("--color-ink") || "#e8eaed";

    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: faint, fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line },
      timeScale: {
        borderColor: line,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (t: UTCTimestamp) => axisTime(t * 1000),
      },
      localization: { timeFormatter: (t: UTCTimestamp) => dateTime(t * 1000), priceFormatter: fmtPrice },
      crosshair: { mode: CrosshairMode.Normal },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderVisible: false,
      wickUpColor: up,
      wickDownColor: down,
      priceFormat: { type: "custom", formatter: fmtPrice, minMove: 1e-14 },
    });
    candles.setData(data.candles.map(([t, o, h, l, c]) => ({ time: t as UTCTimestamp, open: o, high: h, low: l, close: c })));

    const vol = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(
      data.candles.map(([t, o, , , c, v]) => ({ time: t as UTCTimestamp, value: v, color: `${c >= o ? up : down}55` })),
    );

    candles.createPriceLine({ price: entry, color: ink, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "entry" });

    // One marker per side per candle (launch trades fire several fills inside the same bar).
    const times = data.candles.map((c) => c[0]);
    const barOf = (ms: number) => {
      const s = ms / 1000;
      let best = times[0];
      for (const t of times) if (t <= s) best = t;
      return best;
    };
    const groups = new Map<string, { t: number; side: "BUY" | "SELL"; n: number; sol: number; px: number }>();
    for (const f of fills) {
      const t = barOf(f.t);
      const k = `${t}:${f.side}`;
      const g = groups.get(k) ?? { t, side: f.side, n: 0, sol: 0, px: 0 };
      g.px = (g.px * g.n + f.p) / (g.n + 1);
      g.n++;
      g.sol += Math.abs(f.sol);
      groups.set(k, g);
    }
    const markers: SeriesMarker<UTCTimestamp>[] = [...groups.values()]
      .sort((a, b) => a.t - b.t)
      .map((g) => ({
        time: g.t as UTCTimestamp,
        position: g.side === "BUY" ? "atPriceBottom" : "atPriceTop",
        price: g.px,
        shape: g.side === "BUY" ? "arrowUp" : "arrowDown",
        color: g.side === "BUY" ? ink : g.px >= entry ? up : down,
        text: `${g.side === "BUY" ? "Buy" : "Sell"}${g.n > 1 ? ` ×${g.n}` : ""} ${g.sol.toFixed(3)}`,
      }));
    createSeriesMarkers(candles, markers);

    // Frame the trade on first draw for this timeframe; keep the user's zoom on live refreshes.
    if (framed.current !== tf && fills.length) {
      const sec = TF_SEC[tf];
      const a = Math.min(...fills.map((f) => f.t)) / 1000;
      const b = Math.max(...fills.map((f) => f.t), to ?? 0) / 1000;
      chart.timeScale().setVisibleRange({ from: (a - 60 * sec) as UTCTimestamp, to: (b + 30 * sec) as UTCTimestamp });
      framed.current = tf;
    } else if (kept.current) chart.timeScale().setVisibleRange(kept.current);
    else chart.timeScale().fitContent();

    return () => {
      const r = chart.timeScale().getVisibleRange();
      kept.current = r ? { from: r.from as UTCTimestamp, to: r.to as UTCTimestamp } : null;
      chart.remove();
    };
  }, [data, entry, fills, tf, to]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <div className="inline-flex rounded-lg border border-line bg-panel p-0.5">
          {TFS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                framed.current = "";
                kept.current = null;
                setTf(t);
              }}
              className={`h-7 rounded-md px-2.5 text-[12px] transition-colors ${
                t === tf ? "bg-raised font-medium text-ink ring-1 ring-line-strong" : "text-faint hover:text-ink"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <span className="text-[11.5px] text-faint">
          {data?.dex ? `${DEX_LABEL[data.dex] ?? data.dex} · ` : ""}price in SOL · data GeckoTerminal
        </span>
      </div>
      <div className="relative h-[420px] px-1 pb-2 pt-2">
        <div ref={box} className="absolute inset-0" />
        {!data && !error && <div className="absolute inset-0 grid place-items-center text-[13px] text-faint">Loading market chart…</div>}
        {error && <div className="absolute inset-0 grid place-items-center text-[13px] text-faint">Market data is busy. Retrying…</div>}
        {data && !data.candles.length && (
          <div className="absolute inset-0 grid place-items-center px-6 text-center text-[13px] text-faint">
            No candles for this coin at this timeframe yet.
          </div>
        )}
      </div>
    </div>
  );
}

/** The market chart in a collapsible panel; closed by default, and nothing loads until it's opened. */
export function MarketChartPanel({ pumpUrl, ...props }: Parameters<typeof MarketChart>[0] & { pumpUrl: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-panel">
      <header className={`flex h-11 items-center justify-between gap-3 px-4 ${open ? "border-b border-line" : ""}`}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center gap-2 self-stretch text-left text-[13px] font-medium"
        >
          <ChevronDown size={15} className={`text-faint transition-transform ${open ? "" : "-rotate-90"}`} />
          Market chart
        </button>
        <a href={pumpUrl} target="_blank" rel="noreferrer" className="text-[12px] text-faint hover:text-ink">
          Open on pump.fun ↗
        </a>
      </header>
      {open && <MarketChart {...props} />}
    </section>
  );
}
