"use client";
import { useEffect, useState } from "react";
import { clock, sinceMidnight, TZ_LABEL } from "@/lib/time";

/** Current time in the app's timezone (GMT+1), ticking every second. Renders nothing until mounted to avoid a hydration mismatch. */
export default function LiveClock({ seconds = true, label = true }: { seconds?: boolean; label?: boolean }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (now === null) return <span className="num invisible">00:00:00</span>;
  return (
    <span className="num" suppressHydrationWarning>
      {clock(now, seconds)}
      {label && ` ${TZ_LABEL}`}
    </span>
  );
}

/** "10h 12m": time elapsed since midnight GMT+1, updated every 30s. */
export function DayElapsed() {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (now === null) return <span className="invisible">0h 0m</span>;
  return <span suppressHydrationWarning>{sinceMidnight(now)}</span>;
}
