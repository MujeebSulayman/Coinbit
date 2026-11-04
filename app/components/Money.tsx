"use client";
import { createContext, useContext, type ReactNode } from "react";
import { sol, usdAmt } from "@/lib/fmt";

const PriceCtx = createContext<number | null>(null);

/** Makes the SOL/USD price (fetched once in the layout) available to every <Money>. */
export function PriceProvider({ price, children }: { price: number | null; children: ReactNode }) {
  return <PriceCtx.Provider value={price}>{children}</PriceCtx.Provider>;
}

export const useSolPrice = () => useContext(PriceCtx);

/** A SOL amount with its dollar value beside it (or below, with `stack`). */
export function Money({ v, signed, stack }: { v: number; signed?: boolean; stack?: boolean }) {
  const price = useSolPrice();
  return (
    <span className={stack ? "inline-flex flex-col" : "whitespace-nowrap"}>
      {sol(v, signed)}
      {price != null && (
        <span className={`font-normal opacity-60 ${stack ? "mt-0.5 text-[0.62em]" : "ml-1.5 text-[0.82em]"}`}>{usdAmt(v * price, signed)}</span>
      )}
    </span>
  );
}
