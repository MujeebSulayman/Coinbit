"use client";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

/** Makes a whole table row / card clickable without breaking links and buttons inside it. */
export function useRowNav(href: string) {
  const router = useRouter();
  return {
    role: "link",
    tabIndex: 0,
    className: "cursor-pointer",
    onClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("a,button,[role=switch]")) return;
      if (e.metaKey || e.ctrlKey) window.open(href, "_blank");
      else router.push(href);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && e.target === e.currentTarget) router.push(href);
    },
  };
}

export function RowLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  const nav = useRowNav(href);
  return (
    <tr {...nav} className={`${nav.className} ${className}`}>
      {children}
    </tr>
  );
}

export function CardLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  const nav = useRowNav(href);
  return (
    <li {...nav} className={`${nav.className} ${className}`}>
      {children}
    </li>
  );
}
