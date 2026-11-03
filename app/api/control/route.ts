import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { db, setKv } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Dashboard actions. The worker picks these up from the Kv table:
 *  pause | resume | discover | close (positionId) | exclude (address) | unexclude (address)
 */
export async function POST(req: Request) {
  if (!config.adminToken || req.headers.get("x-admin-token") !== config.adminToken) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { action?: string; positionId?: number; address?: string };
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
      await db.wallet.update({ where: { address: body.address }, data: { status: "EXCLUDED", excludeReason: "manual" } });
      break;
    case "unexclude":
      if (!body.address) return new NextResponse("address required", { status: 400 });
      await db.wallet.update({ where: { address: body.address }, data: { status: "CANDIDATE", excludeReason: null } });
      break;
    default:
      return new NextResponse("unknown action", { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
