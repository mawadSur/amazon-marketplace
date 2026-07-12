// POST /api/admin/payouts/retry-shop  { shopId: string }
// Admin-only bulk retry of every stranded payout for a shop (e.g. right after
// ops wires the shop's RazorpayX fund account). Delegates to
// adminRetryStrandedPayoutsForShop, which records an AdminAction audit row.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { adminRetryStrandedPayoutsForShop } from "@/lib/admin";

const bodySchema = z.object({ shopId: z.string().min(1) });

export async function POST(req: Request) {
  let admin;
  try {
    admin = await requireRole("ADMIN");
  } catch {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // fall through to validation
  }
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_INPUT" }, { status: 400 });
  }

  try {
    const results = await adminRetryStrandedPayoutsForShop(parsed.data.shopId, admin.id);
    const disbursed = results.filter((r) => r.status === "initiated").length;
    return NextResponse.json({ total: results.length, disbursed, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ERROR";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
