// Prisma client singleton.
//
// Connection strategy: the runtime client reads DATABASE_URL, which in
// production points at a POOLED endpoint (e.g. PgBouncer / Prisma Accelerate /
// Neon pooler) and may carry `?connection_limit=..&pgbouncer=true`. Migrations
// use the separate, non-pooled DIRECT_URL (wired in prisma/schema.prisma via
// `directUrl`) so DDL runs on a real session, not through the pooler. No
// datasources override is needed here — Prisma reads the pooled URL from env.
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
