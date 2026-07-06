// POST /api/admin/disputes/[id]/resolve — admin resolves a dispute.
// Body: { outcome: "BUYER" | "SELLER", resolution: string }

import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { resolveDispute } from "@/lib/disputes";

const bodySchema = z.object({
  outcome: z.enum(["BUYER", "SELLER"]),
  resolution: z.string().min(5).max(4000),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let admin;
  try {
    admin = await requireRole("ADMIN");
  } catch {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const { id } = await ctx.params;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_INPUT", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const dispute = await resolveDispute({
      disputeId: id,
      adminId: admin.id,
      outcome: parsed.data.outcome,
      resolution: parsed.data.resolution,
    });
    return NextResponse.json({ dispute });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ERROR";
    const status =
      msg === "DISPUTE_NOT_FOUND"
        ? 404
        : msg === "DISPUTE_ALREADY_RESOLVED"
          ? 409
          : msg === "RESOLUTION_REQUIRED"
            ? 400
            : 500;
    // Dispute resolution moves money (refund + payout clawback) — alert on 5xx.
    if (status >= 500) {
      Sentry.captureException(err, { extra: { route: "admin/disputes/resolve", disputeId: id } });
    }
    return NextResponse.json({ error: msg }, { status });
  }
}
