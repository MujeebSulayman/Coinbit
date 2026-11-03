import "dotenv/config";
import { defineConfig } from "prisma/config";

// The app connects through node-postgres, which accepts sslmode=verify-full (and warns on "require").
// Prisma's CLI engine can't do verify-full without a CA file, so CLI commands (db push, studio) use
// "require" — still TLS, still Neon's certificate.
const url = (process.env.DATABASE_URL ?? "").replace("sslmode=verify-full", "sslmode=require");

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url },
});
