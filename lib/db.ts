import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const g = globalThis as unknown as { prisma?: PrismaClient };
export const db =
  g.prisma ?? new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
if (process.env.NODE_ENV !== "production") g.prisma = db;

export async function getKv(key: string): Promise<string | null> {
  const row = await db.kv.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setKv(key: string, value: string) {
  await db.kv.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function log(kind: string, message: string) {
  console.log(`[${new Date().toISOString()}] [${kind}] ${message}`);
  try {
    await db.runLog.create({ data: { kind, message: message.slice(0, 1000) } });
  } catch {
    /* logging must never crash the bot */
  }
}
