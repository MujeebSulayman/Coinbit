"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

function getToken(): string {
  let t = "";
  try {
    t = localStorage.getItem("coinbit:admin") ?? "";
  } catch {}
  if (!t) {
    t = prompt("Admin token (ADMIN_TOKEN from .env)") ?? "";
    try {
      if (t) localStorage.setItem("coinbit:admin", t);
    } catch {}
  }
  return t;
}

export async function control(action: string, extra: Record<string, unknown> = {}) {
  const token = getToken();
  const res = await fetch("/api/control", {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": token },
    body: JSON.stringify({ action, ...extra }),
  });
  if (res.status === 401) {
    try {
      localStorage.removeItem("coinbit:admin");
    } catch {}
    throw new Error("Wrong admin token");
  }
  if (!res.ok) throw new Error(await res.text());
}

export function Button({ action, extra, children, danger }: { action: string; extra?: Record<string, unknown>; children: React.ReactNode; danger?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  return (
    <span className="inline-flex items-center gap-2">
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg("");
          try {
            await control(action, extra);
            setMsg("ok");
            router.refresh();
          } catch (e) {
            setMsg((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
        className={`rounded border px-3 py-1 text-[12px] transition disabled:opacity-50 ${
          danger ? "border-down/50 text-down hover:bg-down/10" : "border-up/50 text-up hover:bg-up/10"
        }`}
      >
        {busy ? "…" : children}
      </button>
      {msg && msg !== "ok" && <span className="text-[11px] text-down">{msg}</span>}
    </span>
  );
}
