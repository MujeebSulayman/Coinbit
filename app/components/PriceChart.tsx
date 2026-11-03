"use client";
import { useEffect, useMemo, useRef, useState } from "react";

export type PricePt = { t: number; p: number };
export type FillPt = { t: number; p: number; side: "BUY" | "SELL"; sol: number; reason: string | null };
export type RefLine = { pct: number; label: string; kind: "entry" | "stop" | "tp" | "tp-hit" };

const PAD = { t: 14, r: 64, b: 22, l: 12 };
const pctText = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%`;
const timeText = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * One series (price, as % vs entry) with reference lines for entry / stop / take-profits and a
 * marker per fill. Crosshair + tooltip on hover; reference lines are direct-labeled on the right.
 */
export default function PriceChart({
  entry,
  points,
  fills,
  refs,
}: {
  entry: number;
  points: PricePt[];
  fills: FillPt[];
  refs: RefLine[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const H = w && w < 520 ? 220 : 300;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toPct = (p: number) => (p / entry - 1) * 100;
  const data = useMemo(() => points.map((d) => ({ t: d.t, v: toPct(d.p) })), [points, entry]); // eslint-disable-line react-hooks/exhaustive-deps

  const geo = useMemo(() => {
    if (!w || data.length < 1) return null;
    const t0 = Math.min(data[0].t, ...fills.map((f) => f.t));
    const t1 = Math.max(data[data.length - 1].t, ...fills.map((f) => f.t), t0 + 60_000);
    // Range: the price path, entry, the active stop and the nearest take-profit (far TPs would flatten the line).
    const vs = data.map((d) => d.v);
    const near = refs.filter((r) => r.kind !== "tp" || r.pct <= Math.max(...vs, 0) * 1.6 + 40);
    let lo = Math.min(0, ...vs, ...near.map((r) => r.pct));
    let hi = Math.max(0, ...vs, ...near.map((r) => r.pct));
    if (hi - lo < 10) hi = lo + 10;
    const padY = (hi - lo) * 0.08;
    lo -= padY;
    hi += padY;
    const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * (w - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    const line = data.map((d, i) => `${i ? "L" : "M"}${x(d.t).toFixed(1)},${y(d.v).toFixed(1)}`).join("");
    return { x, y, line, t0, t1, lo, hi, visible: near };
  }, [w, H, data, fills, refs]);

  const last = data[data.length - 1]?.v ?? 0;
  const stroke = last >= 0 ? "var(--color-up)" : "var(--color-down)";
  const h = hover !== null ? data[hover] : null;
  const refColor = (k: RefLine["kind"]) =>
    k === "stop" ? "var(--color-down)" : k === "entry" ? "var(--color-mute)" : k === "tp-hit" ? "var(--color-faint)" : "var(--color-up)";

  if (data.length < 2)
    return (
      <div className="grid h-40 place-items-center px-6 text-center text-[13px] text-faint">
        No price history for this trade. It's recorded for trades opened from now on; the fills below show what happened.
      </div>
    );

  return (
    <div ref={ref} className="relative select-none" style={{ height: H }}>
      {geo && (
        <svg
          width={w}
          height={H}
          className="block"
          role="img"
          aria-label={`Price since entry, now ${pctText(last)} vs entry`}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const t = geo.t0 + ((e.clientX - r.left - PAD.l) / (w - PAD.l - PAD.r)) * (geo.t1 - geo.t0);
            let best = 0;
            for (let i = 1; i < data.length; i++) if (Math.abs(data[i].t - t) < Math.abs(data[best].t - t)) best = i;
            setHover(best);
          }}
          onPointerLeave={() => setHover(null)}
        >
          {geo.visible.map((r) => (
            <g key={r.kind + r.pct}>
              <line
                x1={PAD.l}
                x2={w - PAD.r}
                y1={geo.y(r.pct)}
                y2={geo.y(r.pct)}
                stroke={refColor(r.kind)}
                strokeOpacity={r.kind === "entry" ? 0.6 : 0.5}
                strokeDasharray={r.kind === "entry" ? "" : "3 4"}
              />
              <text x={w - PAD.r + 6} y={geo.y(r.pct) + 3.5} fontSize={10.5} fill="var(--color-mute)" fontFamily="var(--font-mono)">
                {r.label}
              </text>
            </g>
          ))}
          {data.length > 1 && <path d={geo.line} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
          {fills.map((f, i) => (
            <circle
              key={i}
              cx={geo.x(f.t)}
              cy={geo.y(toPct(f.p))}
              r={5}
              fill={f.side === "BUY" ? "var(--color-ink)" : toPct(f.p) >= 0 ? "var(--color-up)" : "var(--color-down)"}
              stroke="var(--color-panel)"
              strokeWidth={2}
            >
              <title>{`${f.side === "BUY" ? "Buy" : "Sell"} ${f.sol.toFixed(4)} SOL at ${pctText(toPct(f.p))}${f.reason ? ` · ${f.reason}` : ""}`}</title>
            </circle>
          ))}
          {h && hover !== null && (
            <>
              <line x1={geo.x(h.t)} x2={geo.x(h.t)} y1={PAD.t} y2={H - PAD.b} stroke="var(--color-faint)" strokeWidth={1} />
              <circle cx={geo.x(h.t)} cy={geo.y(h.v)} r={4.5} fill={stroke} stroke="var(--color-panel)" strokeWidth={2} />
            </>
          )}
          <text x={PAD.l} y={H - 6} fontSize={10.5} fill="var(--color-faint)" fontFamily="var(--font-mono)">
            {timeText(geo.t0)}
          </text>
          <text x={w - PAD.r} y={H - 6} fontSize={10.5} fill="var(--color-faint)" textAnchor="end" fontFamily="var(--font-mono)">
            {timeText(geo.t1)}
          </text>
        </svg>
      )}
      {geo && h && hover !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-lg border border-line-strong bg-raised/95 px-2.5 py-1.5 text-[11.5px] shadow-xl backdrop-blur"
          style={{ left: Math.min(Math.max(geo.x(h.t) - 75, 0), w - 160), width: 160 }}
        >
          <div className={`num text-[13px] font-medium ${h.v >= 0 ? "text-up" : "text-down"}`}>{pctText(h.v)}</div>
          <div className="num text-mute">{(entry * (1 + h.v / 100)).toExponential(3)} SOL</div>
          <div className="text-faint">{timeText(h.t)}</div>
        </div>
      )}
    </div>
  );
}
