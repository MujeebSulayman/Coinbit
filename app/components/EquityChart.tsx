"use client";
import { useEffect, useMemo, useRef, useState } from "react";

export type EquityPoint = { t: string; v: number; label?: string };

const PAD = { t: 12, r: 12, b: 22, l: 12 };

const fmt = (v: number) =>
  `${v > 0 ? "+" : ""}${v.toFixed(Math.abs(v) < 1 ? 4 : 2)} SOL`;

/** Cumulative realized PnL over closed trades. One series: no legend, crosshair + tooltip on hover. */
export default function EquityChart({ points }: { points: EquityPoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const H = w && w < 520 ? 190 : 270;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Start from zero so the first trade reads as a step away from the baseline.
  const data = useMemo(
    () => [{ t: points[0]?.t ?? "", v: 0 }, ...points],
    [points],
  );

  const geo = useMemo(() => {
    if (!w || data.length < 2) return null;
    const vs = data.map((d) => d.v);
    let lo = Math.min(0, ...vs);
    let hi = Math.max(0, ...vs);
    if (hi === lo) hi = lo + 1;
    const padY = (hi - lo) * 0.08;
    lo -= padY;
    hi += padY;
    const x = (i: number) =>
      PAD.l + (i / (data.length - 1)) * (w - PAD.l - PAD.r);
    const y = (v: number) =>
      PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    const line = data
      .map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.v).toFixed(1)}`)
      .join("");
    const area = `${line}L${x(data.length - 1).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`;
    return { x, y, line, area, zero: y(0) };
  }, [w, H, data]);

  const last = data[data.length - 1]?.v ?? 0;
  const stroke = last >= 0 ? "var(--color-up)" : "var(--color-down)";
  const h = hover !== null ? data[hover] : null;

  return (
    <div ref={ref} className="relative select-none" style={{ height: H }}>
      {geo && (
        <svg
          width={w}
          height={H}
          className="block"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const f = (e.clientX - r.left - PAD.l) / (w - PAD.l - PAD.r);
            setHover(
              Math.max(
                0,
                Math.min(data.length - 1, Math.round(f * (data.length - 1))),
              ),
            );
          }}
          onPointerLeave={() => setHover(null)}
          role="img"
          aria-label={`Cumulative realized PnL over ${points.length} trades, now ${fmt(last)}`}
        >
          <defs>
            <linearGradient id="eq-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <line
            x1={PAD.l}
            x2={w - PAD.r}
            y1={geo.zero}
            y2={geo.zero}
            stroke="var(--color-line-strong)"
            strokeDasharray="3 4"
          />
          <path d={geo.area} fill="url(#eq-fill)" />
          <path
            d={geo.line}
            fill="none"
            stroke={stroke}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {hover !== null && h && (
            <>
              <line
                x1={geo.x(hover)}
                x2={geo.x(hover)}
                y1={PAD.t}
                y2={H - PAD.b}
                stroke="var(--color-faint)"
                strokeWidth={1}
              />
              <circle
                cx={geo.x(hover)}
                cy={geo.y(h.v)}
                r={4.5}
                fill={stroke}
                stroke="var(--color-panel)"
                strokeWidth={2}
              />
            </>
          )}
          <text
            x={PAD.l}
            y={H - 6}
            fontSize={10.5}
            fill="var(--color-faint)"
            fontFamily="var(--font-mono)"
          >
            trade 1
          </text>
          <text
            x={w - PAD.r}
            y={H - 6}
            fontSize={10.5}
            fill="var(--color-faint)"
            textAnchor="end"
            fontFamily="var(--font-mono)"
          >
            trade {points.length}
          </text>
        </svg>
      )}
      {geo && h && hover !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-lg border border-line-strong bg-raised/95 px-2.5 py-1.5 text-[11.5px] shadow-xl backdrop-blur"
          style={{
            left: Math.min(Math.max(geo.x(hover) - 70, 0), w - 150),
            width: 150,
          }}
        >
          <div className="text-faint">
            {hover === 0
              ? "Start"
              : `Trade ${hover}${"label" in h && h.label ? ` · ${h.label}` : ""}`}
          </div>
          <div
            className={`num font-medium ${h.v >= 0 ? "text-up" : "text-down"}`}
          >
            {fmt(h.v)}
          </div>
          {hover > 0 && (
            <div className="text-faint">
              {new Date(h.t).toLocaleString([], {
                dateStyle: "short",
                timeStyle: "short",
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
