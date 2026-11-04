"use client";
import { AlertTriangle, RotateCw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => console.error(error), [error]);
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-24 text-center">
      <div className="grid size-11 place-items-center rounded-xl border border-down/25 bg-down/5 text-down">
        <AlertTriangle size={20} />
      </div>
      <h1 className="text-[18px] font-semibold tracking-tight">Something went wrong</h1>
      <p className="max-w-sm text-[13px] text-faint">
        This page couldn't load. The database may be briefly unreachable, so try again.
        {error.digest && <span className="mono mt-1 block text-[11px]">ref {error.digest}</span>}
      </p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={reset} className="btn btn-primary">
          <RotateCw size={14} /> Try again
        </button>
        <Link href="/" className="btn">
          Overview
        </Link>
      </div>
    </div>
  );
}
