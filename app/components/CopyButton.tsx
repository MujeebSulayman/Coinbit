"use client";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** Small icon button that copies `text` to the clipboard. */
export default function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={copied ? "Copied" : label}
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {}
      }}
      className={`inline-grid size-6 shrink-0 place-items-center rounded-md transition-colors hover:bg-hover ${copied ? "text-up" : "text-faint hover:text-ink"}`}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}
