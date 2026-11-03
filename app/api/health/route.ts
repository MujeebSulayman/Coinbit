import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness probe for the host (Render health check). Doesn't touch the database. */
export function GET() {
  return NextResponse.json({ ok: true });
}
