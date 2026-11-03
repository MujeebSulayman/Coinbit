/**
 * Minimal Solana JSON-RPC websocket client with automatic reconnect + resubscribe.
 * Used instead of web3.js subscriptions because some providers (e.g. Infura) only accept
 * `confirmed` commitment and `jsonParsed` encoding, and web3.js gives no control over either
 * or any visibility into dropped connections.
 */
import { config } from "./config";

type Sub = {
  method: string; // e.g. "logsSubscribe"
  params: unknown[];
  onNotify: (result: any) => void;
  onReject?: (message: string) => void;
  serverId?: number;
};

const STALE_MS = 3 * 60_000; // no traffic at all for this long → assume the socket silently died
const MAX_BACKOFF_MS = 30_000;

class RpcStream {
  private ws: WebSocket | null = null;
  private subs = new Map<number, Sub>(); // local id → sub
  private pending = new Map<number, number>(); // request id → local sub id
  private byServerId = new Map<number, number>(); // server sub id → local id
  private nextLocal = 1;
  private nextReq = 1;
  private backoff = 1000;
  private lastMsg = Date.now();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  reconnects = 0;

  constructor(private url: string) {}

  private connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.lastMsg = Date.now();
      this.byServerId.clear();
      for (const [id, s] of this.subs) this.sendSubscribe(id, s);
    };
    ws.onmessage = (ev) => {
      this.lastMsg = Date.now();
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const local = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (local === undefined) return;
        const s = this.subs.get(local);
        if (!s) return;
        if (msg.error) {
          this.subs.delete(local);
          if (s.onReject) s.onReject(msg.error.message);
          else console.warn(`[stream] ${s.method} rejected: ${msg.error.message}`);
          return;
        }
        s.serverId = msg.result;
        this.byServerId.set(msg.result, local);
        return;
      }
      const local = this.byServerId.get(msg.params?.subscription);
      if (local === undefined) return;
      try {
        this.subs.get(local)?.onNotify(msg.params.result);
      } catch (e) {
        console.error("[stream] handler error", e);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.reconnects++;
      const wait = this.backoff;
      this.backoff = Math.min(MAX_BACKOFF_MS, this.backoff * 2);
      setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => ws.close();
  }

  private ensure() {
    if (!this.ws) this.connect();
    this.watchdog ??= setInterval(() => {
      if (this.ws && this.subs.size && Date.now() - this.lastMsg > STALE_MS) {
        console.warn("[stream] no traffic for 3m, reconnecting");
        this.ws.close();
      }
    }, 30_000);
  }

  private sendSubscribe(local: number, s: Sub) {
    if (this.ws?.readyState !== WebSocket.OPEN) return; // sent on open
    const id = this.nextReq++;
    this.pending.set(id, local);
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: s.method, params: s.params }));
  }

  subscribe(method: string, params: unknown[], onNotify: (result: any) => void, onReject?: (message: string) => void): number {
    this.ensure();
    const local = this.nextLocal++;
    const s: Sub = { method, params, onNotify, onReject };
    this.subs.set(local, s);
    this.sendSubscribe(local, s);
    return local;
  }

  unsubscribe(local: number) {
    const s = this.subs.get(local);
    if (!s) return;
    this.subs.delete(local);
    if (s.serverId !== undefined) {
      this.byServerId.delete(s.serverId);
      if (this.ws?.readyState === WebSocket.OPEN) {
        const method = s.method.replace("Subscribe", "Unsubscribe");
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: this.nextReq++, method, params: [s.serverId] }));
      }
    }
  }

  get healthy() {
    return this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastMsg < STALE_MS;
  }
}

let _stream: RpcStream | null = null;
export function stream(): RpcStream {
  _stream ??= new RpcStream(config.wssUrl);
  return _stream;
}
