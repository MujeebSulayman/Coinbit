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

export function Button({
  action,
  extra,
  children,
  danger,
  primary,
  small,
  confirmText,
  disabled,
  title,
}: {
  action: string;
  extra?: Record<string, unknown>;
  children: React.ReactNode;
  danger?: boolean;
  primary?: boolean;
  small?: boolean;
  confirmText?: string;
  disabled?: boolean;
  title?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  return (
    <span className="inline-flex items-center gap-2">
      <button
        disabled={busy || disabled}
        title={title}
        onClick={async () => {
          if (confirmText && !window.confirm(confirmText)) return;
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
        className={`btn ${danger ? "btn-danger" : primary ? "btn-primary" : ""} ${small ? "btn-sm" : ""}`}
      >
        {busy ? <span className="live-dot">…</span> : children}
      </button>
      {msg && msg !== "ok" && <span className="max-w-48 truncate text-[11px] text-down" title={msg}>{msg}</span>}
    </span>
  );
}

const MODES = [
  ["off", "Off"],
  ["paper", "Paper"],
  ["live", "Live"],
] as const;

/** Off / Paper / Live segmented control for one strategy. */
export function ModeSwitch({ strategy, name, mode }: { strategy: string; name: string; mode: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="inline-flex rounded-lg border border-line bg-bg p-0.5">
        {MODES.map(([m, label]) => {
          const active = m === mode;
          const tint = m === "live" ? "bg-warn/15 text-warn ring-warn/30" : m === "paper" ? "bg-accent/15 text-link ring-accent/30" : "bg-raised text-ink ring-line-strong";
          return (
            <button
              key={m}
              disabled={active || !!busy}
              onClick={async () => {
                if (m === "live" && !window.confirm(`Switch ${name} to LIVE? It will trade real SOL from your trading wallet.`)) return;
                setBusy(m);
                setMsg("");
                try {
                  await control("setMode", { strategy, mode: m });
                  router.refresh();
                } catch (e) {
                  setMsg((e as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
              className={`h-7 min-w-14 rounded-md px-3 text-[12px] font-medium transition-colors ${
                active ? `ring-1 ring-inset ${tint}` : "text-faint hover:text-ink"
              } ${busy === m ? "live-dot" : ""}`}
            >
              {label}
            </button>
          );
        })}
      </div>
      {msg && <span className="text-[11px] text-down">{msg}</span>}
    </div>
  );
}
