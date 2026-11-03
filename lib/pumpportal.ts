/**
 * PumpPortal data stream (wss://pumpportal.fun/api/data), unofficial pump.fun feed.
 * - subscribeNewToken is free: instant creation events (used for watched launchers).
 * - subscribeMigration is free: instant graduation-to-PumpSwap events (migration strategy).
 * - subscribeAccountTrade needs an API key funded with ≥0.02 SOL (PUMPPORTAL_API_KEY):
 *   parsed buys/sells by watched wallets with no extra RPC round-trip.
 * One connection only (PumpPortal asks clients not to open several); reconnects and resubscribes.
 */
import { config } from "./config";

export type PortalTrade = {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: "buy" | "sell" | "create" | "migrate";
  tokenAmount?: number;
  solAmount?: number;
  initialBuy?: number;
  marketCapSol?: number;
  pool?: string;
  symbol?: string;
};

type Handlers = {
  onCreate?: (m: PortalTrade) => void;
  onTrade?: (m: PortalTrade) => void;
  onMigrate?: (m: PortalTrade) => void;
};

let ws: WebSocket | null = null;
const handlers: Handlers = {};
let accounts = new Set<string>();
let backoff = 1000;
let lastMsg = 0;
export const portalEnabledForTrades = () => !!config.pumpPortalKey;

function send(o: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
}

function connect() {
  const url = `wss://pumpportal.fun/api/data${config.pumpPortalKey ? `?api-key=${config.pumpPortalKey}` : ""}`;
  const sock = new WebSocket(url);
  ws = sock;
  sock.onopen = () => {
    backoff = 1000;
    lastMsg = Date.now();
    send({ method: "subscribeNewToken" });
    send({ method: "subscribeMigration" });
    if (portalEnabledForTrades() && accounts.size) send({ method: "subscribeAccountTrade", keys: [...accounts] });
  };
  sock.onmessage = (ev) => {
    lastMsg = Date.now();
    let m: any;
    try {
      m = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (m.message) {
      if (/api key|only available/i.test(m.message)) console.warn(`[pumpportal] ${m.message}`);
      return;
    }
    if (!m.signature || !m.mint) return;
    if (m.txType === "create") handlers.onCreate?.(m);
    else if (m.txType === "migrate") handlers.onMigrate?.(m);
    else if (m.txType === "buy" || m.txType === "sell") handlers.onTrade?.(m);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    setTimeout(connect, backoff);
    backoff = Math.min(30_000, backoff * 2);
  };
  sock.onerror = () => sock.close();
}

/** Registers handlers (several modules can each add theirs) and opens the shared connection. */
export function startPortal(h: Handlers) {
  Object.assign(handlers, h);
  if (ws) return;
  connect();
  // The new-token feed is a constant stream; silence means the socket died.
  setInterval(() => {
    if (ws && Date.now() - lastMsg > 2 * 60_000) ws.close();
  }, 30_000);
}

/** Keeps the account-trade subscription in sync with the watchlist (only with an API key). */
export function setPortalAccounts(want: Set<string>) {
  const add = [...want].filter((a) => !accounts.has(a));
  const remove = [...accounts].filter((a) => !want.has(a));
  accounts = new Set(want);
  if (!portalEnabledForTrades()) return;
  if (add.length) send({ method: "subscribeAccountTrade", keys: add });
  if (remove.length) send({ method: "unsubscribeAccountTrade", keys: remove });
}

export const portalHealthy = () => ws?.readyState === WebSocket.OPEN && Date.now() - lastMsg < 2 * 60_000;
