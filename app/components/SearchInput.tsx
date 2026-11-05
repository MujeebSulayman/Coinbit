"use client";
import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** Debounced search box that keeps its value in the URL (`?{param}=`), leaving other params intact. */
export function SearchInput({ param = "q", placeholder = "Search…" }: { param?: string; placeholder?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const urlValue = params.get(param) ?? "";
  const [v, setV] = useState(urlValue);
  const typing = useRef(false);

  // Follow the URL (back/forward, tab links) unless the user is mid-edit.
  useEffect(() => {
    if (!typing.current) setV(urlValue);
  }, [urlValue]);

  useEffect(() => {
    if (v.trim() === urlValue) {
      typing.current = false;
      return;
    }
    const id = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (v.trim()) next.set(param, v.trim());
      else next.delete(param);
      const qs = next.toString();
      typing.current = false;
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }, 300);
    return () => clearTimeout(id);
  }, [v, urlValue, params, param, pathname, router]);

  return (
    <label className="relative flex h-9 w-full items-center sm:h-8 sm:w-64">
      <Search size={14} className="pointer-events-none absolute left-2.5 text-faint" />
      <input
        type="search"
        value={v}
        onChange={(e) => {
          typing.current = true;
          setV(e.target.value);
        }}
        placeholder={placeholder}
        className="h-full w-full rounded-lg border border-line-strong bg-panel pl-8 pr-8 text-[12.5px] outline-none transition-colors placeholder:text-faint focus:border-accent [&::-webkit-search-cancel-button]:hidden"
      />
      {v && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            typing.current = true;
            setV("");
          }}
          className="absolute right-2 text-faint hover:text-ink"
        >
          <X size={14} />
        </button>
      )}
    </label>
  );
}
