"use client";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { useDialog, type ConfirmOptions } from "./Dialog";

const TOKEN_KEY = "coinbit:admin";

const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};
const writeToken = (t: string | null) => {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
};

export class Cancelled extends Error {}

/** Sends a dashboard action, asking for the admin token in a dialog when needed (and again if it's wrong). */
export function useControl() {
  const { askToken } = useDialog();
  return useCallback(
    async (action: string, extra: Record<string, unknown> = {}) => {
      let token = readToken();
      let error: string | undefined;
      for (;;) {
        if (!token) {
          const t = await askToken({ error });
          if (!t) throw new Cancelled();
          token = t;
        }
        const res = await fetch("/api/control", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": token,
          },
          body: JSON.stringify({ action, ...extra }),
        });
        if (res.status === 401) {
          writeToken(null);
          token = "";
          error =
            "That token wasn't accepted. Check ADMIN_TOKEN and try again.";
          continue;
        }
        if (!res.ok)
          throw new Error(
            (await res.text()) || `Request failed (${res.status})`,
          );
        writeToken(token);
        return;
      }
    },
    [askToken],
  );
}

export function Button({
  action,
  extra,
  children,
  danger,
  primary,
  small,
  confirm,
  done,
  disabled,
  title,
  className = "",
}: {
  action: string;
  extra?: Record<string, unknown>;
  children: React.ReactNode;
  danger?: boolean;
  primary?: boolean;
  small?: boolean;
  /** Ask in a dialog before sending. */
  confirm?: ConfirmOptions;
  /** Toast shown on success. */
  done?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const router = useRouter();
  const dialog = useDialog();
  const control = useControl();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy || disabled}
      title={title}
      onClick={async () => {
        if (confirm && !(await dialog.confirm({ danger, ...confirm }))) return;
        setBusy(true);
        try {
          await control(action, extra);
          if (done) dialog.toast(done);
          router.refresh();
        } catch (e) {
          if (!(e instanceof Cancelled))
            dialog.toast((e as Error).message, "error");
        } finally {
          setBusy(false);
        }
      }}
      className={`btn ${danger ? "btn-danger" : primary ? "btn-primary" : ""} ${small ? "btn-sm" : ""} ${className}`}
    >
      {busy ? <span className="live-dot">Working…</span> : children}
    </button>
  );
}

const MODES = [
  ["off", "Off"],
  ["paper", "Paper"],
  ["live", "Live"],
] as const;

/** Off / Paper / Live segmented control for one strategy. */
export function ModeSwitch({
  strategy,
  name,
  mode,
}: {
  strategy: string;
  name: string;
  mode: string;
}) {
  const router = useRouter();
  const dialog = useDialog();
  const control = useControl();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="inline-flex rounded-lg border border-line bg-bg p-0.5">
      {MODES.map(([m, label]) => {
        const active = m === mode;
        const tint =
          m === "live"
            ? "bg-warn/15 text-warn ring-warn/30"
            : m === "paper"
              ? "bg-accent/15 text-link ring-accent/30"
              : "bg-raised text-ink ring-line-strong";
        return (
          <button
            key={m}
            disabled={active || !!busy}
            onClick={async () => {
              if (
                m === "live" &&
                !(await dialog.confirm({
                  title: `Switch ${name} to live trading?`,
                  body: "It will start trading real SOL from your trading wallet. You can switch back to Paper at any time.",
                  confirmLabel: "Go live",
                  danger: true,
                }))
              )
                return;
              setBusy(m);
              try {
                await control("setMode", { strategy, mode: m });
                dialog.toast(`${name} is now ${label.toLowerCase()}`);
                router.refresh();
              } catch (e) {
                if (!(e instanceof Cancelled))
                  dialog.toast((e as Error).message, "error");
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
  );
}
