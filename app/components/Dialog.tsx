"use client";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  X,
  XCircle,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/** In-app replacements for window.confirm / window.prompt, plus toasts. */

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
};
type TokenOptions = { error?: string };
type Toast = { id: number; kind: "ok" | "error"; text: string };

type Ctx = {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  askToken: (o?: TokenOptions) => Promise<string | null>;
  toast: (text: string, kind?: Toast["kind"]) => void;
};

const DialogCtx = createContext<Ctx | null>(null);

export function useDialog() {
  const c = useContext(DialogCtx);
  if (!c) throw new Error("useDialog must be used inside <DialogProvider>");
  return c;
}

type Open =
  | { type: "confirm"; o: ConfirmOptions; resolve: (v: boolean) => void }
  | { type: "token"; o: TokenOptions; resolve: (v: string | null) => void }
  | null;

export function DialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Open>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) =>
        setOpen({ type: "confirm", o, resolve }),
      ),
    [],
  );
  const askToken = useCallback(
    (o: TokenOptions = {}) =>
      new Promise<string | null>((resolve) =>
        setOpen({ type: "token", o, resolve }),
      ),
    [],
  );
  const toast = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      kind === "error" ? 6000 : 3000,
    );
  }, []);

  const close = (v: boolean | string | null) => {
    if (!open) return;
    if (open.type === "confirm") open.resolve(v === true);
    else open.resolve(typeof v === "string" ? v : null);
    setOpen(null);
  };

  return (
    <DialogCtx.Provider value={{ confirm, askToken, toast }}>
      {children}
      {open && (
        <Modal onClose={() => close(open.type === "confirm" ? false : null)}>
          {open.type === "confirm" ? (
            <ConfirmBody o={open.o} onDone={close} />
          ) : (
            <TokenBody o={open.o} onDone={close} />
          )}
        </Modal>
      )}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="toast-in pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border border-line-strong bg-raised px-3.5 py-3 text-[13px] shadow-2xl"
          >
            {t.kind === "ok" ? (
              <CheckCircle2 size={16} className="mt-px shrink-0 text-up" />
            ) : (
              <XCircle size={16} className="mt-px shrink-0 text-down" />
            )}
            <span className="min-w-0 flex-1 break-words">{t.text}</span>
            <button
              onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
              className="text-faint hover:text-ink"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </DialogCtx.Provider>
  );
}

function Modal({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="fade-in absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="sheet-in relative w-full max-w-md rounded-t-2xl border border-line-strong bg-panel p-5 shadow-2xl sm:rounded-2xl">
        {children}
      </div>
    </div>
  );
}

function ConfirmBody({
  o,
  onDone,
}: {
  o: ConfirmOptions;
  onDone: (v: boolean) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <>
      <div className="flex gap-3.5">
        <div
          className={`grid size-9 shrink-0 place-items-center rounded-full ${o.danger ? "bg-down/10 text-down" : "bg-accent/10 text-accent"}`}
        >
          <AlertTriangle size={17} />
        </div>
        <div className="min-w-0 pt-1">
          <h2 className="text-[15px] font-semibold">{o.title}</h2>
          {o.body && (
            <div className="mt-1.5 text-[13px] leading-relaxed text-mute">
              {o.body}
            </div>
          )}
        </div>
      </div>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button className="btn h-9 sm:h-[30px]" onClick={() => onDone(false)}>
          Cancel
        </button>
        <button
          ref={ref}
          className={`btn h-9 sm:h-[30px] ${o.danger ? "btn-danger-solid" : "btn-primary"}`}
          onClick={() => onDone(true)}
        >
          {o.confirmLabel ?? "Confirm"}
        </button>
      </div>
    </>
  );
}

function TokenBody({
  o,
  onDone,
}: {
  o: TokenOptions;
  onDone: (v: string | null) => void;
}) {
  const [v, setV] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onDone(v.trim());
      }}
    >
      <div className="flex gap-3.5">
        <div className="grid size-9 shrink-0 place-items-center rounded-full bg-accent/10 text-accent">
          <KeyRound size={17} />
        </div>
        <div className="min-w-0 pt-1">
          <h2 className="text-[15px] font-semibold">Admin access</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-mute">
            Enter the dashboard&apos;s{" "}
            <span className="mono text-ink">ADMIN_TOKEN</span> to control the
            bot. It&apos;s remembered on this device.
          </p>
        </div>
      </div>
      <input
        autoFocus
        type="password"
        autoComplete="current-password"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="Admin token"
        className={`mono mt-4 h-10 w-full rounded-lg border bg-bg px-3 text-[13px] outline-none transition-colors placeholder:text-faint focus:border-accent ${
          o.error ? "border-down/60" : "border-line-strong"
        }`}
      />
      {o.error && <p className="mt-1.5 text-[12px] text-down">{o.error}</p>}
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          className="btn h-9 sm:h-[30px]"
          onClick={() => onDone(null)}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!v.trim()}
          className="btn btn-primary h-9 sm:h-[30px]"
        >
          Unlock
        </button>
      </div>
    </form>
  );
}
