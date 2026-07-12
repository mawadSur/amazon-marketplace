// Dispute lifecycle for Module 6. Buyers open disputes on their orders;
// admins resolve them. All admin mutations write a paired AdminAction in
// the same transaction. A buyer-favored resolution flips the Order to REFUNDED
// AND drives real refund movement: enqueueRefund (Stripe/Razorpay) plus
// reversePayoutsForOrder to claw back any already-released seller payouts.

import { Prisma } from "@prisma/client";
import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/db";
import { enqueueRefund } from "@/lib/payments";
import { reversePayoutsForOrder, reinstatePayoutForShop } from "@/lib/payouts";
import { refreshOrderStatusAfterDisputeResolution } from "@/lib/orders";
import { claimBuyerProtection } from "@/lib/buyer-protection";
import { enqueueTrustRecompute } from "@/lib/trust-score";
import { log } from "@/lib/log";

const dlog = log.child({ module: "disputes" });
import type {
  Dispute,
  DisputeReason,
  DisputeStatus,
} from "@prisma/client";

// ---------------------------------------------------------------- helpers

/** Recompute trust for every shop with an item in this order (best-effort). */
async function recomputeShopsForOrder(orderId: string): Promise<void> {
  try {
    const items = await prisma.orderItem.findMany({
      where: { orderId },
      select: { shopId: true },
    });
    const shopIds = [...new Set(items.map((i) => i.shopId))];
    await Promise.all(shopIds.map((id) => enqueueTrustRecompute(id)));
  } catch {
    /* best-effort — never block the dispute action */
  }
}

// ---------------------------------------------------------------- open

export type OpenDisputeInput = {
  orderId: string;
  buyerId: string;
  reason: DisputeReason;
  description: string;
  evidenceUrls?: string[];
  /** The specific OrderItem ids being disputed. All MUST belong to the same shop
   * — a dispute is per-shop (Wave 2). Required. */
  orderItemIds: string[];
};

const ORDER_OPENABLE_STATUSES = new Set([
  "PAID",
  "PROCESSING",
  "SHIPPED",
  "DELIVERED",
  "COMPLETED",
  // Already-DISPUTED orders remain openable so a buyer can file a SEPARATE
  // per-shop dispute against a different shop on the same multi-shop order.
  "DISPUTED",
]);

/**
 * Buyer-protection claim window: a dispute (and its full refund) can only be
 * opened within this many days of delivery. Bounds our refund liability so a
 * buyer can't claw back funds months after receiving the goods.
 */
export const DISPUTE_CLAIM_WINDOW_DAYS = 30;
const DISPUTE_CLAIM_WINDOW_MS = DISPUTE_CLAIM_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Open a per-shop dispute over specific items (Wave 2). The buyer selects one or
 * more OrderItem(s); they must all belong to the SAME shop, and the dispute
 * carries that shopId + the disputed orderItemIds. One dispute per (order, shop)
 * is enforced (schema @@unique + a pre-check). The disputed items flip to
 * OrderItem.status = DISPUTED and the order is flagged DISPUTED.
 *
 * Throws ORDER_NOT_FOUND / ORDER_NOT_DISPUTABLE / ALREADY_DISPUTED /
 * DESCRIPTION_REQUIRED / CLAIM_WINDOW_EXPIRED / ITEMS_REQUIRED / ITEMS_INVALID /
 * ITEMS_MULTIPLE_SHOPS / ITEMS_NOT_DISPUTABLE.
 */
export async function openDispute(input: OpenDisputeInput): Promise<Dispute> {
  const description = input.description?.trim() ?? "";
  if (!description) throw new Error("DESCRIPTION_REQUIRED");

  const requestedItemIds = [...new Set((input.orderItemIds ?? []).filter((id) => id))];
  if (requestedItemIds.length === 0) throw new Error("ITEMS_REQUIRED");

  const order = await prisma.order.findFirst({
    where: { id: input.orderId, buyerId: input.buyerId },
    select: {
      id: true,
      status: true,
      deliveredAt: true,
      items: { select: { id: true, shopId: true, status: true } },
    },
  });
  if (!order) throw new Error("ORDER_NOT_FOUND");
  if (!ORDER_OPENABLE_STATUSES.has(order.status)) {
    throw new Error("ORDER_NOT_DISPUTABLE");
  }
  // Claim window: once delivered, the buyer has DISPUTE_CLAIM_WINDOW_DAYS to
  // open a claim. Undelivered orders (deliveredAt null) are not yet bounded.
  if (order.deliveredAt && Date.now() - order.deliveredAt.getTime() > DISPUTE_CLAIM_WINDOW_MS) {
    throw new Error("CLAIM_WINDOW_EXPIRED");
  }

  // Resolve the selected items against the order and enforce single-shop scope.
  const byId = new Map(order.items.map((it) => [it.id, it]));
  const selected = requestedItemIds.map((id) => byId.get(id));
  if (selected.some((it) => !it)) throw new Error("ITEMS_INVALID");
  const items = selected as { id: string; shopId: string; status: string }[];
  const shopIds = [...new Set(items.map((it) => it.shopId))];
  if (shopIds.length > 1) throw new Error("ITEMS_MULTIPLE_SHOPS");
  const shopId = shopIds[0];
  // Can't dispute items already refunded (their money already went back).
  if (items.some((it) => it.status === "REFUNDED")) throw new Error("ITEMS_NOT_DISPUTABLE");

  // One dispute per (order, shop): reject a second dispute for the same shop.
  const existing = await prisma.dispute.findUnique({
    where: { orderId_shopId: { orderId: input.orderId, shopId } },
    select: { id: true },
  });
  if (existing) throw new Error("ALREADY_DISPUTED");

  const evidenceUrls = (input.evidenceUrls ?? [])
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  const itemIds = items.map((it) => it.id);

  let dispute: Dispute;
  try {
    dispute = await prisma.$transaction(async (tx) => {
      const d = await tx.dispute.create({
        data: {
          orderId: input.orderId,
          shopId,
          orderItemIds: itemIds,
          openedById: input.buyerId,
          reason: input.reason,
          description,
          evidenceUrls,
          status: "OPEN",
        },
      });
      // Flip only THIS shop's disputed items to DISPUTED (leave other shops' items
      // untouched — a per-shop dispute is item-scoped).
      await tx.orderItem.updateMany({
        where: { orderId: input.orderId, id: { in: itemIds } },
        data: { status: "DISPUTED" },
      });
      await tx.order.update({
        where: { id: input.orderId },
        data: { status: "DISPUTED" },
      });
      return d;
    });
  } catch (err) {
    // Lost a race to a concurrent open for the same (order, shop).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new Error("ALREADY_DISPUTED");
    }
    throw err;
  }

  // Flip BuyerProtection to CLAIMED outside the TX so a failure here doesn't
  // block dispute opening. Best-effort.
  try {
    await claimBuyerProtection(input.orderId);
  } catch {
    /* ignore */
  }

  // A new dispute drags the seller's trust score down — recompute.
  await recomputeShopsForOrder(input.orderId);

  return dispute;
}

// ---------------------------------------------------------------- resolve

export type ResolveDisputeInput = {
  disputeId: string;
  adminId: string;
  outcome: "BUYER" | "SELLER";
  resolution: string;
};

/**
 * Resolve ONE shop's per-shop dispute (Wave 2). Writes Dispute.status +
 * resolution and an AdminAction, and:
 *   - outcome=BUYER: flips ONLY this dispute's items to REFUNDED, enqueues a
 *     PARTIAL per-shop refund (refundOrderItems, scoped to shopId + the disputed
 *     items), and claws back ONLY this shop's payout (reversePayoutsForOrder with
 *     shopId). Innocent shops on the same order are never refunded or clawed back.
 *   - outcome=SELLER: reverts this dispute's items back to ACTIVE.
 * The order's headline status is then DERIVED (deriveOrderStatus): DISPUTED while
 * any dispute is still open, REFUNDED only once ALL items are refunded, else back
 * to its fulfillment status with per-item REFUNDED marks carrying the detail.
 *
 * Order-level BuyerProtection is deliberately NOT resolved-to-PAID here: that
 * path issues a WHOLE-ORDER refund (ref refund_<order>), which would double-refund
 * on top of the per-shop partial refunds. Per-shop dispute money moves solely
 * through the scoped refund path.
 */
export async function resolveDispute(input: ResolveDisputeInput): Promise<Dispute> {
  const resolution = input.resolution?.trim() ?? "";
  if (!resolution) throw new Error("RESOLUTION_REQUIRED");

  const dispute = await prisma.dispute.findUnique({
    where: { id: input.disputeId },
    select: {
      id: true,
      status: true,
      orderId: true,
      shopId: true,
      orderItemIds: true,
    },
  });
  if (!dispute) throw new Error("DISPUTE_NOT_FOUND");
  if (dispute.status === "RESOLVED_BUYER" || dispute.status === "RESOLVED_SELLER") {
    throw new Error("DISPUTE_ALREADY_RESOLVED");
  }

  const nextDisputeStatus: DisputeStatus =
    input.outcome === "BUYER" ? "RESOLVED_BUYER" : "RESOLVED_SELLER";

  return prisma.$transaction(async (tx) => {
    const updated = await tx.dispute.update({
      where: { id: dispute.id },
      data: {
        status: nextDisputeStatus,
        resolution,
        resolvedAt: new Date(),
      },
    });

    if (input.outcome === "BUYER") {
      // Mark ONLY this shop's disputed items REFUNDED (scoped to shopId + the
      // dispute's item ids). The actual gateway refund runs best-effort below.
      await tx.orderItem.updateMany({
        where: { orderId: dispute.orderId, shopId: dispute.shopId, id: { in: dispute.orderItemIds } },
        data: { status: "REFUNDED" },
      });
    } else {
      // Seller wins — this shop's disputed items return to ACTIVE.
      await tx.orderItem.updateMany({
        where: {
          orderId: dispute.orderId,
          shopId: dispute.shopId,
          id: { in: dispute.orderItemIds },
          status: "DISPUTED",
        },
        data: { status: "ACTIVE" },
      });
    }

    // Derive the order's headline status from the post-update item statuses +
    // any still-open disputes (per-shop: other shops may still be in dispute).
    await refreshOrderStatusAfterDisputeResolution(tx, dispute.orderId);

    await tx.adminAction.create({
      data: {
        adminId: input.adminId,
        targetType: "dispute",
        targetId: dispute.id,
        action: input.outcome === "BUYER" ? "resolve_buyer" : "resolve_seller",
        reason: resolution,
      },
    });

    return updated;
  }).then(async (updated) => {
    // Side-effects outside the TX. Each is best-effort — none should roll
    // back the resolution. Admins can retry from /admin/orders/[id] if needed.
    if (input.outcome === "BUYER") {
      try {
        // PARTIAL per-shop refund — only this shop's disputed items.
        await enqueueRefund({
          orderId: dispute.orderId,
          reason: resolution,
          shopId: dispute.shopId,
          orderItemIds: dispute.orderItemIds,
        });
      } catch {
        /* refund retried by the payments.refund worker */
      }
      // Claw back ONLY this shop's payout (post-delivery disputes). No-op when
      // funds were still held (pre-delivery). Best-effort: reversePayoutsForOrder
      // never throws, so it can't block the buyer refund. shopId scopes it so
      // innocent shops on the same order keep their payouts; a partial dispute
      // claws back only the disputed items' portion.
      await reversePayoutsForOrder(dispute.orderId, resolution, dispute.shopId);
    } else {
      // Seller won — the disputed items are ACTIVE again. If the weekly batch had
      // cancelled/held this shop's payout because the items were DISPUTED, the
      // seller would otherwise never be paid. Re-establish the payout for the
      // now-active items (best-effort; the batch disburses it on its next run).
      try {
        await reinstatePayoutForShop(dispute.orderId, dispute.shopId);
      } catch (err) {
        // Never block resolution, but DON'T swallow silently: a thrown reinstatement
        // failure would otherwise leave the vindicated seller unpaid with no signal
        // (the helper self-alerts only on its return-value cases, not on a throw).
        dlog.error(
          { err, orderId: dispute.orderId, shopId: dispute.shopId },
          "payout reinstatement threw on seller-favored dispute — seller may be unpaid, needs manual review",
        );
        Sentry.captureException(err, {
          extra: { orderId: dispute.orderId, shopId: dispute.shopId, phase: "reinstate-payout" },
        });
      }
    }
    // Resolution may change the shop's standing — recompute trust.
    await recomputeShopsForOrder(dispute.orderId);
    return updated;
  });
}

// ---------------------------------------------------------------- reads

export type AdminDisputeFilter = {
  status?: DisputeStatus[];
  /** Default true — only show un-resolved unless overridden. */
  openOnly?: boolean;
};

const adminListInclude = {
  openedBy: { select: { id: true, email: true, name: true, phone: true } },
  order: {
    select: {
      id: true,
      status: true,
      totalUsdCents: true,
      placedAt: true,
      deliveredAt: true,
    },
  },
} satisfies Prisma.DisputeInclude;

export async function listDisputesForAdmin(filter: AdminDisputeFilter = {}) {
  const statuses =
    filter.status ??
    (filter.openOnly === false
      ? undefined
      : (["OPEN", "UNDER_REVIEW"] as DisputeStatus[]));

  return prisma.dispute.findMany({
    where: statuses ? { status: { in: statuses } } : undefined,
    orderBy: { openedAt: "desc" },
    take: 200,
    include: adminListInclude,
  });
}

const buyerDisputeInclude = {
  order: {
    select: {
      id: true,
      status: true,
      totalUsdCents: true,
      placedAt: true,
      items: {
        include: {
          product: {
            select: {
              id: true,
              slug: true,
              title: true,
              images: {
                orderBy: { position: "asc" as const },
                take: 1,
                select: { url: true },
              },
              shop: { select: { name: true, slug: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.DisputeInclude;

const adminDetailInclude = {
  openedBy: { select: { id: true, email: true, name: true, phone: true } },
  shop: { select: { id: true, name: true, slug: true } },
  order: {
    select: {
      id: true,
      status: true,
      totalUsdCents: true,
      placedAt: true,
      deliveredAt: true,
      shippingAddress: true,
      items: {
        include: {
          product: {
            select: {
              id: true,
              slug: true,
              title: true,
              shopId: true,
              images: {
                orderBy: { position: "asc" as const },
                take: 1,
                select: { url: true },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.DisputeInclude;

export type AdminDisputeDetail = Prisma.DisputeGetPayload<{
  include: typeof adminDetailInclude;
}>;
export type BuyerDisputeDetail = Prisma.DisputeGetPayload<{
  include: typeof buyerDisputeInclude;
}>;

/** Admin-side dispute detail; null if not found. */
export async function getDisputeForAdmin(
  disputeId: string,
): Promise<AdminDisputeDetail | null> {
  return prisma.dispute.findUnique({
    where: { id: disputeId },
    include: adminDetailInclude,
  });
}

/** Buyer-side dispute detail; caller must verify ownership. */
export async function getDisputeForBuyer(
  disputeId: string,
): Promise<BuyerDisputeDetail | null> {
  return prisma.dispute.findUnique({
    where: { id: disputeId },
    include: buyerDisputeInclude,
  });
}

/** Role-routed wrapper. Prefer `getDisputeForAdmin` / `getDisputeForBuyer`. */
export async function getDispute(
  disputeId: string,
  role: "BUYER" | "ADMIN",
): Promise<AdminDisputeDetail | BuyerDisputeDetail | null> {
  return role === "ADMIN"
    ? getDisputeForAdmin(disputeId)
    : getDisputeForBuyer(disputeId);
}

export async function listDisputesForBuyer(buyerId: string) {
  return prisma.dispute.findMany({
    where: { openedById: buyerId },
    orderBy: { openedAt: "desc" },
    take: 100,
    include: {
      order: {
        select: {
          id: true,
          status: true,
          totalUsdCents: true,
          placedAt: true,
        },
      },
    },
  });
}
