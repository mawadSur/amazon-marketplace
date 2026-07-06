// GET /api/health/ready — READINESS probe.
//
// Checks the app's dependencies and reports whether this task should receive
// traffic:
//   - Postgres (via Prisma `SELECT 1`) is a HARD dependency: if it's down we
//     return 503 so the ALB stops routing to this task.
//   - Redis (via `PING`) is a SOFT dependency: if it's down we still return 200
//     (the app can degrade gracefully) but surface redis:"degraded" so the
//     failing dependency is obvious in logs/metrics.
//
// Kept force-dynamic + nodejs so it never gets cached and always reflects live
// dependency state.

import { NextResponse } from "next/server";
import IORedis from "ioredis";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const hlog = log.child({ module: "health" });

// Module-level singleton — the ALB hits this frequently, so we don't want to
// open a fresh Redis socket per request. lazyConnect keeps boot cheap.
let _redis: IORedis | null = null;
function redis(): IORedis | null {
  if (!env.REDIS_URL) return null;
  if (!_redis) {
    _redis = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });
    _redis.on("error", (err) => hlog.error({ err }, "health redis error"));
  }
  return _redis;
}

async function checkDb(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    hlog.error({ err }, "db health check failed");
    return false;
  }
}

let _connecting: Promise<void> | null = null;
async function ensureConnected(client: IORedis): Promise<void> {
  if (client.status === "ready") return;
  // Dedupe concurrent connects so racing health checks don't trip
  // ioredis' "already connecting" error.
  if (!_connecting) {
    _connecting = client
      .connect()
      .catch((err) => {
        // Another caller may have already opened it; a ready socket is fine.
        if (client.status !== "ready") throw err;
      })
      .finally(() => {
        _connecting = null;
      });
  }
  await _connecting;
}

async function checkRedis(): Promise<boolean> {
  const client = redis();
  if (!client) return false;
  try {
    await ensureConnected(client);
    const pong = await client.ping();
    return pong === "PONG";
  } catch (err) {
    hlog.error({ err }, "redis health check failed");
    return false;
  }
}

export async function GET() {
  const [db, redisOk] = await Promise.all([checkDb(), checkRedis()]);
  // DB is the only hard dependency: it alone determines readiness (200 vs 503).
  // Redis is soft — report "degraded" but keep serving traffic.
  return NextResponse.json(
    {
      status: db ? "ok" : "unavailable",
      db,
      redis: redisOk ? "ok" : "degraded",
    },
    { status: db ? 200 : 503 },
  );
}
