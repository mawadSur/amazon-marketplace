// POST /api/shipments/[id]/advance
//
// Dev-only helper: advances a shipment one step in the lifecycle
// (LABEL_CREATED → PICKED_UP → IN_TRANSIT → CUSTOMS → OUT_FOR_DELIVERY → DELIVERED).
//
// Allowed callers:
//   - ADMIN (any shipment)
//   - SELLER who owns the shop tied to at least one of the order's items
//
// In production this would be a webhook from Shiprocket; for the MVP we
// expose this so the seller can demo the full lifecycle by hand.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { simulateShipmentProgress } from "@/lib/shipments";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  let user;
  try {
    user = await requireUser();
  } catch {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { id } = await ctx.params;

  const shipment = await prisma.shipment.findUnique({
    where: { id },
    select: {
      id: true,
      order: {
        select: { items: { select: { shopId: true } } },
      },
    },
  });
  if (!shipment) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  // ADMIN bypasses ownership checks.
  if (user.role !== "ADMIN") {
    const shop = await prisma.shop.findUnique({
      where: { ownerId: user.id },
      select: { id: true },
    });
    const sellerOwns =
      !!shop && shipment.order.items.some((it) => it.shopId === shop.id);
    if (!sellerOwns) {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }
  }

  try {
    const updated = await simulateShipmentProgress(shipment.id);
    return NextResponse.json({ shipment: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ERROR";
    const status =
      msg === "SHIPMENT_NOT_FOUND" ? 404 : msg === "SIMULATION_DISABLED" ? 403 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
