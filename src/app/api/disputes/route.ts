// POST /api/disputes — buyer opens a dispute against an order they own.
// Body: { orderId, reason, description, evidenceUrls? }

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { openDispute } from "@/lib/disputes";

const bodySchema = z.object({
  orderId: z.string().min(1),
  // The specific items being disputed. All must belong to ONE shop (enforced
  // server-side) — a dispute is per-shop.
  orderItemIds: z.array(z.string().min(1)).min(1).max(100),
  reason: z.enum([
    "NOT_RECEIVED",
    "NOT_AS_DESCRIBED",
    "DAMAGED",
    "COUNTERFEIT",
    "OTHER",
  ]),
  description: z.string().min(10).max(4000),
  evidenceUrls: z.array(z.string().url().max(1000)).max(10).optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (session.user.role !== "BUYER") {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

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
    const dispute = await openDispute({
      orderId: parsed.data.orderId,
      buyerId: session.user.id,
      orderItemIds: parsed.data.orderItemIds,
      reason: parsed.data.reason,
      description: parsed.data.description,
      evidenceUrls: parsed.data.evidenceUrls,
    });
    return NextResponse.json({ dispute });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ERROR";
    const status =
      msg === "ORDER_NOT_FOUND"
        ? 404
        : msg === "ALREADY_DISPUTED"
          ? 409
          : msg === "ORDER_NOT_DISPUTABLE" ||
              msg === "DESCRIPTION_REQUIRED" ||
              msg === "ITEMS_REQUIRED" ||
              msg === "ITEMS_INVALID" ||
              msg === "ITEMS_MULTIPLE_SHOPS" ||
              msg === "ITEMS_NOT_DISPUTABLE" ||
              msg === "CLAIM_WINDOW_EXPIRED"
            ? 400
            : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}
