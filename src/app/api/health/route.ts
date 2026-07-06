// GET /api/health — LIVENESS probe for the ALB target group / ECS.
//
// Returns 200 { status: "ok" } whenever the process is up. It intentionally
// does NOT touch Postgres or Redis: a dependency blip must never make ECS kill
// an otherwise-healthy task. Readiness (dependency health) lives at
// /api/health/ready.
//
// Kept intentionally lightweight and force-dynamic so it never gets cached.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ status: "ok" });
}
