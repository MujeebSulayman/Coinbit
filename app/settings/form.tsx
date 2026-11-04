"use client";
import { RotateCcw, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Cancelled, useControl } from "../components/Controls";
import { useDialog } from "../components/Dialog";
import { Badge, Panel } from "../components/ui";

type Def = {
  key: string;
  env: string;
  label: string;
  group: string;
  kind: "num" | "int" | "bool" | "ladder";
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  help: string;
};
type Ladder = { gainPct: number; sellPct: number }[];

const toText = (d: Def, v: unknown) =>
  d.kind === "ladder" ? (v as Ladder).map((x) => `${x.gainPct}:${x.sellPct}`).join(",") : d.kind === "bool" ? String(!!v) : String(v ?? "");

export default function SettingsForm({
  groups,
  defs,
  values,
  baseline,
  overridden,
  pending,
}: {
  groups: string[];
  defs: Def[];
  values: Record<string, unknown>;
  baseline: Record<string, unknown>;
  overridden: string[];
  pending: string[];
}) {
  const router = useRouter();
  const dialog = useDialog();
  const control = useControl();
  const initial = useMemo(() => Object.fromEntries(defs.map((d) => [d.key, toText(d, values[d.key])])), [defs, values]);
  const [draft, setDraft] = useState<Record<string, string>>(initial);
  useEffect(() => setDraft(initial), [initial]); // after save/reset, start from the new values
  const isPending = new Set(pending);
  const [busy, setBusy] = useState(false);
  const dirty = defs.filter((d) => draft[d.key] !== initial[d.key]);
  const isOverridden = new Set(overridden);
  const slug = (g: string) => "s-" + g.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // Warn before closing or reloading the tab with unsaved edits.
  useEffect(() => {
    if (!dirty.length) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty.length]);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      dialog.toast(ok);
      router.refresh();
    } catch (e) {
      if (!(e instanceof Cancelled)) dialog.toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const changes = Object.fromEntries(dirty.map((d) => [d.key, d.kind === "bool" ? draft[d.key] === "true" : draft[d.key]]));
      await control("setSettings", { values: changes });
    }, `Saved ${dirty.length} setting${dirty.length === 1 ? "" : "s"}; the worker applies them within ~15s`);

  return (
    <div className="space-y-5 pb-20">
      <nav className="flex flex-wrap gap-1.5" aria-label="Setting groups">
        {groups.map((g) => {
          const n = defs.filter((d) => d.group === g && draft[d.key] !== initial[d.key]).length;
          return (
            <a key={g} href={`#${slug(g)}`} className="btn btn-sm text-mute">
              {g}
              {n > 0 && <span className="num rounded bg-warn/15 px-1 text-[10.5px] text-warn">{n}</span>}
            </a>
          );
        })}
      </nav>
      {groups.map((g) => (
        <div key={g} id={slug(g)} className="scroll-mt-20 md:scroll-mt-6">
        <Panel title={g}>
          <div className="divide-y divide-line">
            {defs
              .filter((d) => d.group === g)
              .map((d) => {
                const changed = draft[d.key] !== initial[d.key];
                return (
                  <div key={d.key} className="grid gap-2 px-4 py-3 md:grid-cols-[1fr_auto] md:items-center md:gap-6">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium">{d.label}</span>
                        {isOverridden.has(d.key) && <Badge kind="accent">overridden</Badge>}
                        {changed && <Badge kind="warn">unsaved</Badge>}
                        {!changed && isPending.has(d.key) && <Badge kind="mute">applying…</Badge>}
                      </div>
                      <div className="mt-0.5 text-[12px] text-faint">
                        {d.help} <span className="mono text-[11px]">{d.env}</span>
                        {isOverridden.has(d.key) && <> · default {toText(d, baseline[d.key])}</>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {d.kind === "bool" ? (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={draft[d.key] === "true"}
                          onClick={() => setDraft({ ...draft, [d.key]: draft[d.key] === "true" ? "false" : "true" })}
                          className={`relative h-6 w-11 rounded-full transition-colors ${draft[d.key] === "true" ? "bg-accent" : "bg-line-strong"}`}
                        >
                          <span
                            className={`absolute top-0.5 size-5 rounded-full bg-white transition-all ${draft[d.key] === "true" ? "left-[22px]" : "left-0.5"}`}
                          />
                        </button>
                      ) : (
                        <div className="flex items-center rounded-lg border border-line-strong bg-bg focus-within:border-accent">
                          <input
                            value={draft[d.key]}
                            onChange={(e) => setDraft({ ...draft, [d.key]: e.target.value })}
                            inputMode={d.kind === "ladder" ? "text" : "decimal"}
                            spellCheck={false}
                            className={`num h-8 bg-transparent px-2.5 text-right outline-none ${d.kind === "ladder" ? "w-56" : "w-32"}`}
                          />
                          {d.unit && <span className="pr-2.5 text-[11.5px] text-faint">{d.unit}</span>}
                        </div>
                      )}
                      <button
                        type="button"
                        title="Reset to default"
                        disabled={busy || !isOverridden.has(d.key)}
                        onClick={() => run(() => control("resetSetting", { key: d.key }), `${d.label} reset to default`)}
                        className="btn btn-ghost btn-sm disabled:invisible"
                      >
                        <RotateCcw size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>
        </Panel>
        </div>
      ))}

      <div className="sticky bottom-4 z-10 flex justify-end">
        <div className="flex items-center gap-2 rounded-xl border border-line-strong bg-panel/95 p-2 shadow-lg backdrop-blur">
          {overridden.length > 0 && (
            <button
              type="button"
              disabled={busy}
              className="btn btn-ghost"
              onClick={async () => {
                if (
                  !(await dialog.confirm({
                    title: "Reset all settings?",
                    body: "Every override is removed and the worker goes back to its environment variables and code defaults.",
                    confirmLabel: "Reset all",
                    danger: true,
                  }))
                )
                  return;
                run(() => control("resetAllSettings"), "All settings reset to defaults");
              }}
            >
              Reset all
            </button>
          )}
          <button type="button" className="btn" disabled={busy || !dirty.length} onClick={() => setDraft(initial)}>
            Discard
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !dirty.length} onClick={save}>
            <Save size={14} />
            {dirty.length ? `Save ${dirty.length} change${dirty.length === 1 ? "" : "s"}` : "No changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
