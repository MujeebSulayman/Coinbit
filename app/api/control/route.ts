import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { db, setKv } from "@/lib/db";
import { setStrategyMode, STRATEGIES, type Strategy } from "@/lib/modes";
import { getOverrides, parseSetting, saveOverrides } from "@/lib/settings";
import type { StrategyMode } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Dashboard actions. The worker picks these up from the Kv table:
 *  pause | resume | discover | close (positionId) | exclude (address) | unexclude (address)
 *  setMode (strategy: copy|migration, mode: off|paper|live)
 *  setSettings (values: { key: value }) | resetSetting (key) | resetAllSettings
 */
export async function POST(req: Request) {
  if (!config.adminToken || req.headers.get("x-admin-token") !== config.adminToken) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    positionId?: number;
    address?: string;
    strategy?: string;
    mode?: string;
    values?: Record<string, unknown>;
    key?: string;
  };
  switch (body.action) {
    case "pause":
      await setKv("trading:paused", "true");
      break;
    case "resume":
      await setKv("trading:paused", "false");
      break;
    case "discover":
      await setKv("discovery:requested", new Date().toISOString());
      break;
    case "close":
      if (!body.positionId) return new NextResponse("positionId required", { status: 400 });
      await setKv(`close:${body.positionId}`, "1");
      break;
    case "exclude":
      if (!body.address) return new NextResponse("address required", { status: 400 });
      await db.wallet.update({ where: { address: body.address }, data: { status: "EXCLUDED", excludeReason: "manual", allowed: false } });
      break;
    case "unexclude":
      if (!body.address) return new NextResponse("address required", { status: 400 });
      await db.wallet.update({ where: { address: body.address }, data: { status: "CANDIDATE", excludeReason: null, allowed: true } });
      break;
    case "setMode": {
      if (!STRATEGIES.includes(body.strategy as Strategy) || !["off", "paper", "live"].includes(body.mode ?? ""))
        return new NextResponse("strategy and mode required", { status: 400 });
      try {
        await setStrategyMode(body.strategy as Strategy, body.mode as StrategyMode);
      } catch (e) {
        return new NextResponse((e as Error).message, { status: 400 });
      }
      break;
    }
    case "setSettings": {
      const o = await getOverrides();
      const errors: string[] = [];
      for (const [k, raw] of Object.entries(body.values ?? {})) {
        const r = parseSetting(k, raw);
        if ("error" in r) errors.push(r.error);
        else o[k] = r.value;
      }
      if (errors.length) return new NextResponse(errors.join("; "), { status: 400 });
      await saveOverrides(o);
      break;
    }
    case "resetSetting": {
      const o = await getOverrides();
      if (body.key) delete o[body.key];
      await saveOverrides(o);
      break;
    }
    case "resetAllSettings":
      await saveOverrides({});
      break;
    default:
      return new NextResponse("unknown action", { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
