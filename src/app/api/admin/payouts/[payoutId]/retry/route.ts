// POST /api/admin/payouts/[payoutId]/retry
// Admin-only retry of a single stranded payout. Delegates to
// adminRetryPayout, which calls the money-safe payouts.retryPayout and records
// an AdminAction audit row.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { adminRetryPayout } from "@/lib/admin";

export async function POST(_req: Request, ctx: { params: Promise<{ payoutId: string }> }) {
  let admin;
  try {
    admin = await requireRole("ADMIN");
  } catch {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const { payoutId } = await ctx.params;
  try {
    const result = await adminRetryPayout(payoutId, admin.id);
    return NextResponse.json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ERROR";
    const status = msg === "PAYOUT_NOT_FOUND" ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
