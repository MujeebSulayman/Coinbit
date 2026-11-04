"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-fetches the page's server data every `ms`, paused while the tab is hidden (and refreshed on return). */
export default function AutoRefresh({ ms = 10_000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      clearInterval(id);
      id = setInterval(() => router.refresh(), ms);
    };
    const onVisibility = () => {
      if (document.hidden) return clearInterval(id);
      router.refresh();
      start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, ms]);
  return null;
}
