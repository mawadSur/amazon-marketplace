// POST /api/admin/payouts/run-batch
// Admin-only "run the weekly payout batch now". Delegates to adminRunPayoutBatch,
// which calls the money-safe (idempotent) runPayoutBatch and records an
// AdminAction audit row. Safe to trigger even if the scheduled run is imminent —
// the batch only claims still-PENDING payouts, so it never double-disburses.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { adminRunPayoutBatch } from "@/lib/admin";

export async function POST() {
  let admin;
  try {
    admin = await requireRole("ADMIN");
  } catch {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  try {
    const result = await adminRunPayoutBatch(admin.id);
    return NextResponse.json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ERROR";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
