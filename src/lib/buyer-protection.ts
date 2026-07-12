// Buyer Protection (D6). Every PAID order gets an auto-created coverage row.
// MVP: self-funded pool capped per-order. Claim creation happens via dispute
// resolution (when admin sides with the buyer) or — later — directly from
// /buyer/orders/[id]/protection. Real insurance partner integration is TODO.

import { prisma } from "@/lib/db";

const PER_ORDER_COVERAGE_CAP_USD_CENTS = 100_000; // $1,000 max per order

export function calculateCoverageUsdCents(orderTotalUsdCents: number): number {
  return Math.min(orderTotalUsdCents, PER_ORDER_COVERAGE_CAP_USD_CENTS);
}

/**
 * Create the BuyerProtection row at order capture. Idempotent on the (unique)
 * orderId — re-running for the same order is safe.
 */
export async function createBuyerProtection(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, totalUsdCents: true, protection: { select: { id: true } } },
  });
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (order.protection) return; // already created

  await prisma.buyerProtection.create({
    data: {
      orderId: order.id,
      status: "ELIGIBLE",
      coverageUsdCents: calculateCoverageUsdCents(order.totalUsdCents),
    },
  });
}

/** Flip protection to CLAIMED. Called when a buyer opens a dispute. */
export async function claimBuyerProtection(orderId: string): Promise<void> {
  const existing = await prisma.buyerProtection.findUnique({ where: { orderId } });
  if (!existing) return; // never created — order pre-dated protection rollout
  if (existing.status !== "ELIGIBLE") return; // already claimed/paid/denied
  await prisma.buyerProtection.update({
    where: { id: existing.id },
    data: { status: "CLAIMED", claimedAt: new Date() },
  });
}

/**
 * Admin resolution path: PAID = buyer reimbursed, DENIED = claim rejected.
 *
 * PAID moves REAL money through the SINGLE idempotent refund path
 * (enqueueRefund → refundOrder). In the dispute flow — where the buyer branch
 * has already enqueued a refund — that path no-ops on the already-REFUNDED
 * order, so disputed orders are NEVER refunded twice. In a standalone
 * buyer-protection claim (no prior refund) it is the one thing that actually
 * returns the funds. We deliberately do NOT introduce a second refund mechanism.
 *
 * The status flip is written first and only advanced once, so a replay of the
 * whole call is itself a no-op (existing.status guard). enqueueRefund is
 * dynamically imported to break the payments ↔ buyer-protection module cycle.
 */
export async function resolveBuyerProtection(
  orderId: string,
  outcome: "PAID" | "DENIED",
  resolution: string,
): Promise<void> {
  const existing = await prisma.buyerProtection.findUnique({ where: { orderId } });
  if (!existing) return;
  if (existing.status === "PAID" || existing.status === "DENIED") return;

  // A whole-order buyer-protection PAID refund must NEVER run on an order that has
  // per-shop dispute handling. refundOrder's full path refunds the ENTIRE order
  // (incl. innocent shops), and the resulting full charge.refunded webhook claws
  // back every shop's payout — double-refunding the already-partially-refunded
  // shop and clawing innocent ones. Per-shop dispute money moves SOLELY through the
  // scoped refund path (resolveDispute). Refuse here; only a standalone claim (no
  // disputes) uses this whole-order path. Guard before the status flip so a misuse
  // is a clean no-op the caller can surface.
  if (outcome === "PAID") {
    const disputeCount = await prisma.dispute.count({ where: { orderId } });
    if (disputeCount > 0) throw new Error("ORDER_HAS_PER_SHOP_DISPUTES");
  }

  await prisma.buyerProtection.update({
    where: { id: existing.id },
    data: { status: outcome, resolvedAt: new Date(), resolution },
  });

  if (outcome === "PAID") {
    // Route through the one idempotent refund path (standalone claim only, per the
    // guard above). Best-effort enqueue — the worker retries on gateway failure.
    const { enqueueRefund } = await import("@/lib/payments");
    await enqueueRefund({ orderId, reason: resolution });
  }
}
